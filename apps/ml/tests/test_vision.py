"""Тесты лиц и питомцев на подставных сетях (настоящие YuNet, SFace и YOLOX проверяются на сервере: app.py --selftest).

Подставные сети выдают заранее известные ответы, поэтому проверяется то, что делаем мы: разбор выходов, пересчёт
в доли картинки, выравнивание лица, подавление дублей, размеры, защита от плохих входов и память (выгрузка)."""
import base64
import json
import os
import sys
import tempfile
import unittest

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import app  # noqa: E402
import vision  # noqa: E402
from test_app import DIM, Server, build_models, jpeg, small, vec  # noqa: E402


def const_net(outputs, in_name, in_shape):
    """Сеть без вычислений: на любой вход отдаёт готовые массивы (список (имя, массив))."""
    inits, nodes, outs = [], [], []
    for name, arr in outputs:
        inits.append(numpy_helper.from_array(arr.astype(np.float32), name + "_c"))
        nodes.append(helper.make_node("Identity", [name + "_c"], [name]))
        outs.append(helper.make_tensor_value_info(name, TensorProto.FLOAT, list(arr.shape)))
    # вход должен участвовать в графе, иначе onnxruntime его выбросит
    nodes.append(helper.make_node("ReduceMean", [in_name], ["unused"], keepdims=0))
    outs.append(helper.make_tensor_value_info("unused", TensorProto.FLOAT, None))
    g = helper.make_graph(nodes, "c", [helper.make_tensor_value_info(in_name, TensorProto.FLOAT, in_shape)], outs, inits)
    return small(g)


def yunet_outputs(face_cell=(20, 25), stride=8, size=(10.0, 12.0)):
    """Выходы YuNet с одним уверенным лицом в клетке (строка, столбец) масштаба stride."""
    r, c = face_cell
    outs = []
    shapes = {8: 6400, 16: 1600, 32: 400}
    cls = {s: np.zeros((1, n, 1)) for s, n in shapes.items()}
    obj = {s: np.zeros((1, n, 1)) for s, n in shapes.items()}
    bbox = {s: np.zeros((1, n, 4)) for s, n in shapes.items()}
    kps = {s: np.zeros((1, n, 10)) for s, n in shapes.items()}
    cols = 640 // stride
    i = r * cols + c
    cls[stride][0, i, 0] = 0.9
    obj[stride][0, i, 0] = 0.9
    bbox[stride][0, i] = [0.5, 0.5, np.log(size[0] / stride * 1.0), np.log(size[1] / stride * 1.0)]
    # пять точек относительно клетки (в шагах сетки)
    pts = [(-1.0, -1.0), (1.0, -1.0), (0.0, 0.0), (-0.8, 1.2), (0.8, 1.2)]
    for j, (px, py) in enumerate(pts):
        kps[stride][0, i, 2 * j], kps[stride][0, i, 2 * j + 1] = px, py
    for kind, d in (("cls", cls), ("obj", obj), ("bbox", bbox), ("kps", kps)):
        for s in (8, 16, 32):
            outs.append((f"{kind}_{s}", d[s]))
    return outs


class VisionUnit(unittest.TestCase):
    def test_nms_removes_overlaps_and_keeps_best(self):
        boxes = np.array([[0, 0, 10, 10], [1, 1, 11, 11], [50, 50, 60, 60]], dtype=np.float64)
        scores = np.array([0.7, 0.9, 0.8])
        self.assertEqual(sorted(vision.nms(boxes, scores, 0.3)), [1, 2])

    def test_windows_cover_whole_image(self):
        w, h = 1280, 900
        cover = np.zeros((h, w), dtype=bool)
        for x, y in vision._windows(w, h):
            self.assertTrue(0 <= x <= w - 640 and 0 <= y <= h - 640)
            cover[y : y + 640, x : x + 640] = True
        self.assertTrue(cover.all())

    def test_similarity_recovers_known_transform(self):
        src = vision.FACE_TEMPLATE
        ang, k, t = 0.3, 1.7, np.array([25.0, -9.0])
        rot = np.array([[np.cos(ang), -np.sin(ang)], [np.sin(ang), np.cos(ang)]])
        dst = (k * (rot @ src.T)).T + t
        m = vision._similarity(dst, src)  # обратная задача: из повёрнутого в эталон
        back = (m[:, :2] @ dst.T).T + m[:, 2]
        np.testing.assert_allclose(back, src, atol=1e-6)

    def test_align_face_size_and_content(self):
        img = Image.new("RGB", (300, 300), (10, 20, 30))
        out = vision.align_face(img, (vision.FACE_TEMPLATE * 2 + 40).tolist())
        self.assertEqual(out.size, (112, 112))
        self.assertEqual(out.getpixel((56, 56)), (10, 20, 30))

    def test_yunet_decode_geometry(self):
        found = vision._yunet_decode([a for _, a in yunet_outputs((20, 25), 8, (40.0, 48.0))], 0.8)
        self.assertEqual(len(found), 1)
        box, score, lm = found[0]
        cx, cy = (25 + 0.5) * 8, (20 + 0.5) * 8
        np.testing.assert_allclose(box, [cx - 20, cy - 24, cx + 20, cy + 24], atol=1e-3)
        self.assertAlmostEqual(score, 0.9, places=3)
        np.testing.assert_allclose(lm[0], [(25 - 1) * 8, (20 - 1) * 8], atol=1e-3)
        np.testing.assert_allclose(lm[4], [(25 + 0.8) * 8, (20 + 1.2) * 8], atol=1e-3)

    def test_crop_with_margin_stays_inside(self):
        img = Image.new("RGB", (100, 80))
        c = vision.crop_with_margin(img, [0, 0, 100, 80], 0.2)
        self.assertEqual(c.size, (100, 80))
        c2 = vision.crop_with_margin(img, [40, 30, 20, 20], 0.5)
        self.assertEqual(c2.size, (40, 40))


class VisionServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = cls.tmp.name
        build_models(os.path.join(root, "model"))
        os.makedirs(os.path.join(root, "faces"))
        os.makedirs(os.path.join(root, "pets"))
        # лицо в клетке (30, 40) масштаба 8: центр около (324, 244) на квадрате 640
        onnx.save(const_net(yunet_outputs((30, 40), 8, (80.0, 96.0)), "input", [1, 3, 640, 640]), os.path.join(root, "faces", "yunet.onnx"))
        rng = np.random.default_rng(3)
        w = numpy_helper.from_array(rng.normal(size=(3, 128)).astype(np.float32), "w")
        g = helper.make_graph(
            [helper.make_node("ReduceMean", ["data"], ["m"], axes=[2, 3], keepdims=0), helper.make_node("MatMul", ["m", "w"], ["fc1"])],
            "s",
            [helper.make_tensor_value_info("data", TensorProto.FLOAT, [1, 3, 112, 112])],
            [helper.make_tensor_value_info("fc1", TensorProto.FLOAT, [1, 128])],
            [w],
        )
        onnx.save(small(g), os.path.join(root, "faces", "sface.onnx"))
        # YOLOX: одна кошка в клетке (40, 40) масштаба 8 размером 160x120 и одна собака, перекрывающая её (должна уйти)
        out = np.zeros((1, 8400, 85), dtype=np.float32)
        i = 40 * 80 + 40
        out[0, i, 0:2] = [0.5, 0.5]
        out[0, i, 2:4] = np.log([160 / 8, 120 / 8])
        out[0, i, 4] = 0.95
        out[0, i, 5 + vision.COCO_CAT] = 0.9
        j = i + 1
        out[0, j, 0:2] = [0.5, 0.5]
        out[0, j, 2:4] = np.log([160 / 8, 120 / 8])
        out[0, j, 4] = 0.9
        out[0, j, 5 + vision.COCO_DOG] = 0.6
        onnx.save(const_net([("output", out)], "images", [1, 3, 640, 640]), os.path.join(root, "pets", "yolox_s.onnx"))
        cls.s = Server(os.path.join(root, "model"), faces_dir=os.path.join(root, "faces"), pets_dir=os.path.join(root, "pets"))

    @classmethod
    def tearDownClass(cls):
        cls.s.close()
        cls.tmp.cleanup()

    def test_health_reports_readiness(self):
        _, j = self.s.call("GET", "/health")
        self.assertTrue(j["faces"]["ready"] and j["pets"]["ready"])

    def test_faces_boxes_are_fractions_and_vectors_are_unit(self):
        code, j = self.s.call("POST", "/faces", jpeg((120, 90, 60), (640, 640)))
        self.assertEqual(code, 200, j)
        self.assertEqual(len(j["faces"]), 1)
        f = j["faces"][0]
        x, y, w, h = f["box"]
        self.assertAlmostEqual(w, 80 / 640, places=3)
        self.assertAlmostEqual(h, 96 / 640, places=3)
        self.assertAlmostEqual(x, (40.5 * 8 - 40) / 640, places=3)
        self.assertAlmostEqual(y, (30.5 * 8 - 48) / 640, places=3)
        v = np.frombuffer(base64.b64decode(f["vector"]), dtype="<f4")
        self.assertEqual(len(v), 128)
        self.assertAlmostEqual(float(np.linalg.norm(v)), 1.0, places=4)

    def test_faces_on_non_square_and_large_images_stay_fractions(self):
        for size in ((1000, 500), (3000, 2000)):
            code, j = self.s.call("POST", "/faces", jpeg((120, 90, 60), size))
            self.assertEqual(code, 200, j)
            for f in j["faces"]:
                x, y, w, h = f["box"]
                self.assertTrue(0 <= x <= 1 and 0 <= y <= 1 and 0 < w <= 1 and 0 < h <= 1, f["box"])

    def test_pets_found_with_clip_vector_and_overlap_removed(self):
        code, j = self.s.call("POST", "/pets", jpeg((60, 90, 120), (640, 640)))
        self.assertEqual(code, 200, j)
        self.assertEqual([p["kind"] for p in j["pets"]], ["cat"], "собака на том же месте уходит")
        p = j["pets"][0]
        x, y, w, h = p["box"]
        self.assertAlmostEqual(w, 160 / 640, places=3)
        self.assertAlmostEqual(h, 120 / 640, places=3)
        self.assertEqual(len(base64.b64decode(p["vector"])), DIM * 4)

    def test_bad_input_and_missing_models(self):
        self.assertEqual(self.s.call("POST", "/faces", b"not an image")[0], 400)
        self.assertEqual(self.s.call("POST", "/pets", b"")[0], 400)
        empty = Server(os.path.join(self.tmp.name, "model"), faces_dir="/nonexistent", pets_dir="/nonexistent")
        try:
            self.assertEqual(empty.call("POST", "/faces", jpeg((1, 2, 3)))[0], 503)
            self.assertEqual(empty.call("POST", "/pets", jpeg((1, 2, 3)))[0], 503)
            _, h = empty.call("GET", "/health")
            self.assertFalse(h["faces"]["ready"] or h["pets"]["ready"])
        finally:
            empty.close()

    def test_memory_is_released_after_idle(self):
        self.s.call("POST", "/faces", jpeg((120, 90, 60), (640, 640)))
        self.assertEqual(self.s.models.aux_kind, "faces")
        self.s.models.last -= 10_000
        self.s.models.unload_if_idle()
        self.assertIsNone(self.s.models.aux_kind)
        self.assertEqual(self.s.models.aux, {})


if __name__ == "__main__":
    unittest.main()
