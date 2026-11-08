"""Тесты ML-сервиса на крошечной поддельной модели (настоящая тяжёлая модель проверяется на мини-ПК: app.py --selftest)."""
import base64
import http.client
import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper
from PIL import Image
from tokenizers import Tokenizer, models, pre_tokenizers

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import app  # noqa: E402

DIM = 16


def small(graph):
    # Версия формата IR 8 понятна любому onnxruntime (новый пакет onnx по умолчанию пишет более свежую).
    m = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    m.ir_version = 8
    return m


def build_models(root):
    rng = np.random.default_rng(1)
    # Картинка: среднее по пикселям каждого канала, потом линейное преобразование 3 -> DIM.
    w = numpy_helper.from_array(rng.normal(size=(3, DIM)).astype(np.float32), "w")
    g = helper.make_graph(
        [helper.make_node("ReduceMean", ["image"], ["m"], axes=[2, 3], keepdims=0), helper.make_node("MatMul", ["m", "w"], ["emb"])],
        "v",
        [helper.make_tensor_value_info("image", TensorProto.FLOAT, [1, 3, 224, 224])],
        [helper.make_tensor_value_info("emb", TensorProto.FLOAT, [1, DIM])],
        [w],
    )
    os.makedirs(os.path.join(root, "visual"))
    onnx.save(small(g), os.path.join(root, "visual", "model.onnx"))
    # Текст: номера слов (int32, 77 штук) -> линейное преобразование 77 -> DIM.
    w2 = numpy_helper.from_array(rng.normal(size=(77, DIM)).astype(np.float32), "w2")
    g2 = helper.make_graph(
        [helper.make_node("Cast", ["text"], ["f"], to=TensorProto.FLOAT), helper.make_node("MatMul", ["f", "w2"], ["emb"])],
        "t",
        [helper.make_tensor_value_info("text", TensorProto.INT32, [1, 77])],
        [helper.make_tensor_value_info("emb", TensorProto.FLOAT, [1, DIM])],
        [w2],
    )
    os.makedirs(os.path.join(root, "textual"))
    onnx.save(small(g2), os.path.join(root, "textual", "model.onnx"))
    vocab = {"<unk>": 0, "<pad>": 1}
    for i, word in enumerate(["кошка", "cat", "собака", "dog", "пляж", "автомобиль", "на"], start=2):
        vocab[word] = i
    tok = Tokenizer(models.WordLevel(vocab, unk_token="<unk>"))
    tok.pre_tokenizer = pre_tokenizers.Whitespace()
    tok.save(os.path.join(root, "textual", "tokenizer.json"))


def jpeg(color, size=(80, 60)):
    b = io.BytesIO()
    Image.new("RGB", size, color).save(b, "JPEG")
    return b.getvalue()


def vec(resp):
    return np.frombuffer(base64.b64decode(resp["vector"]), dtype="<f4")


class Server:
    def __init__(self, model_dir, **env):
        self.cfg = app.Config()
        self.cfg.model_dir = model_dir
        self.cfg.model_id = "fake"
        self.cfg.threads = 1
        for k, v in env.items():
            setattr(self.cfg, k, v)
        self.models = app.Models(self.cfg)
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), app.make_handler(self.cfg, self.models))
        self.srv.daemon_threads = True
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def call(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        c.request(method, path, body=body, headers=headers or {})
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, json.loads(data)

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


class MlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        build_models(cls.tmp.name)
        cls.s = Server(cls.tmp.name)

    @classmethod
    def tearDownClass(cls):
        cls.s.close()
        cls.tmp.cleanup()

    def test_health(self):
        code, j = self.s.call("GET", "/health")
        self.assertEqual(code, 200)
        self.assertTrue(j["ok"] and j["ready"])
        self.assertEqual(j["model"], "fake")

    def test_image_vector_is_unit_and_stable(self):
        code, a = self.s.call("POST", "/embed/image", jpeg((200, 30, 30)))
        self.assertEqual(code, 200)
        va = vec(a)
        self.assertEqual(len(va), DIM)
        self.assertAlmostEqual(float(np.linalg.norm(va)), 1.0, places=4)
        _, b = self.s.call("POST", "/embed/image", jpeg((200, 30, 30)))
        np.testing.assert_allclose(va, vec(b), atol=1e-5)
        _, c = self.s.call("POST", "/embed/image", jpeg((20, 30, 220)))
        self.assertLess(float(va @ vec(c)), 0.999)

    def test_text_vector_and_difference(self):
        def t(s):
            code, j = self.s.call("POST", "/embed/text", json.dumps({"text": s}).encode(), {"Content-Type": "application/json"})
            self.assertEqual(code, 200, j)
            return vec(j)

        v1, v2 = t("кошка"), t("собака на пляже")
        self.assertAlmostEqual(float(np.linalg.norm(v1)), 1.0, places=4)
        self.assertLess(float(v1 @ v2), 0.999)
        np.testing.assert_allclose(t("кошка"), t("  кошка  "), atol=1e-5)  # пробелы по краям не влияют

    def test_bad_inputs(self):
        self.assertEqual(self.s.call("POST", "/embed/image", b"not an image")[0], 400)
        self.assertEqual(self.s.call("POST", "/embed/text", b"{", {"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.s.call("POST", "/embed/text", json.dumps({"text": "   "}).encode())[0], 400)
        self.assertEqual(self.s.call("POST", "/embed/text", json.dumps({"text": "я" * 1001}).encode())[0], 400)
        self.assertEqual(self.s.call("POST", "/embed/text", json.dumps({"x": 1}).encode())[0], 400)
        self.assertEqual(self.s.call("GET", "/nope")[0], 404)

    def test_one_half_in_memory_and_idle_unload(self):
        self.s.call("POST", "/embed/image", jpeg((1, 2, 3)))
        self.assertEqual(self.s.models.kind, "visual")
        self.s.call("POST", "/embed/text", json.dumps({"text": "cat"}).encode())
        self.assertEqual(self.s.models.kind, "textual")  # картиночная половина выгружена
        self.s.cfg.idle_sec = 1
        time.sleep(1.2)
        self.s.models.unload_if_idle()
        self.assertIsNone(self.s.models.kind)
        self.s.cfg.idle_sec = 120

    def test_missing_files(self):
        with tempfile.TemporaryDirectory() as empty:
            s = Server(empty)
            try:
                code, j = s.call("GET", "/health")
                self.assertTrue(j["ok"])
                self.assertFalse(j["ready"])
                self.assertEqual(s.call("POST", "/embed/image", jpeg((1, 1, 1)))[0], 503)
                self.assertEqual(s.call("POST", "/embed/text", json.dumps({"text": "cat"}).encode())[0], 503)
            finally:
                s.close()

    def test_huge_body_rejected(self):
        c = http.client.HTTPConnection("127.0.0.1", self.s.port, timeout=10)
        c.putrequest("POST", "/embed/image")
        c.putheader("Content-Length", str(25 * 1024 * 1024))
        c.endheaders()
        r = c.getresponse()
        self.assertEqual(r.status, 400)
        c.close()


if __name__ == "__main__":
    unittest.main()
