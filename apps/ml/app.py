"""DV Cloud ML: векторы (эмбеддинги) картинок и текста для поиска по смыслу.

Маленький HTTP-сервис без внешних зависимостей, кроме onnxruntime, numpy, Pillow и tokenizers.
Работает только внутри закрытой сети Docker (без выхода в интернет), снаружи не виден.

  GET  /health        состояние: готовы ли файлы модели, что сейчас загружено в память
  POST /embed/image   тело: сама картинка (JPEG, PNG, WebP); ответ: вектор картинки
  POST /embed/text    тело: {"text": "собака на пляже"}; ответ: вектор текста

Вектор приходит как base64 от float32 (little-endian), длина 1, уже нормированный: сходство двух
векторов равно их скалярному произведению. Картинки и текст попадают в одно пространство, поэтому
по тексту можно искать картинки на любом языке, который знает модель.

Память: в каждый момент загружена только одна половина модели (картинки или текст), а после паузы
(DVML_IDLE_SEC) память отдаётся обратно. Пока работы нет, контейнер занимает несколько десятков МБ.
"""
import base64
import gc
import io
import json
import os
import sys
import threading
import time

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps
from tokenizers import Tokenizer

Image.MAX_IMAGE_PIXELS = 60_000_000  # защита от «бомб»: огромных по размеру картинок

# Нормировка CLIP: средние и разброс по каналам RGB (одинаковые для OpenAI CLIP и OpenCLIP/LAION).
MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)
SIDE = 224
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_TEXT_CHARS = 1000


def env_int(name, default, lo, hi):
    try:
        v = int(os.environ.get(name, default))
    except ValueError:
        return default
    return v if lo <= v <= hi else default


class Config:
    def __init__(self):
        self.model_dir = os.environ.get("DVML_MODEL_DIR", "/models/model")
        self.model_id = os.environ.get("DVML_MODEL_ID", os.path.basename(self.model_dir.rstrip("/")))
        self.threads = env_int("DVML_THREADS", 2, 1, 16)
        self.idle_sec = env_int("DVML_IDLE_SEC", 120, 1, 86400)
        self.text_len = env_int("DVML_TEXT_LEN", 77, 8, 512)
        self.port = env_int("DVML_PORT", 8090, 1, 65535)

    def path(self, *parts):
        return os.path.join(self.model_dir, *parts)


class ModelError(Exception):
    """Модель недоступна (нет файлов, не открылась)."""


class InputError(Exception):
    """Плохой вход: не картинка, пустой текст."""


def prep_image(data):
    """Картинка -> тензор 1x3x224x224: короткая сторона до 224 (бикубика), обрезка по центру, нормировка."""
    try:
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img).convert("RGB")
    except Exception as e:  # битый файл, неизвестный формат, слишком большая картинка
        raise InputError("картинка не читается: %s" % type(e).__name__)
    img = ImageOps.fit(img, (SIDE, SIDE), Image.BICUBIC)
    a = (np.asarray(img, dtype=np.float32) / 255.0 - MEAN) / STD
    return np.ascontiguousarray(a.transpose(2, 0, 1)[None, ...])


def unit(v):
    v = np.asarray(v, dtype=np.float64).reshape(-1)
    n = np.linalg.norm(v)
    if not np.isfinite(n) or n == 0:
        raise ModelError("модель вернула пустой вектор")
    return (v / n).astype("<f4")


def encode(v):
    return base64.b64encode(v.tobytes()).decode("ascii")


def trim_memory():
    """Вернуть системе освобождённую память (glibc держит её у себя без этого)."""
    gc.collect()
    try:
        import ctypes

        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:
        pass


class Models:
    """Ленивая загрузка половин модели. Все вызовы идут по одному (замок), как и нужно слабому процессору."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.lock = threading.Lock()
        self.kind = None  # "visual" | "textual" | None
        self.session = None
        self.tok = None
        self.last = time.monotonic()
        self.dim = None

    def files_ready(self):
        c = self.cfg
        return all(os.path.isfile(c.path(*p)) for p in (("visual", "model.onnx"), ("textual", "model.onnx"), ("textual", "tokenizer.json")))

    def _open(self, rel):
        path = self.cfg.path(*rel)
        if not os.path.isfile(path):
            raise ModelError("нет файла модели: " + "/".join(rel))
        o = ort.SessionOptions()
        o.intra_op_num_threads = self.cfg.threads
        o.inter_op_num_threads = 1
        o.enable_cpu_mem_arena = False  # меньше «про запас»: память на небольшом сервере дорогая
        o.enable_mem_pattern = False
        try:
            return ort.InferenceSession(path, o, providers=["CPUExecutionProvider"])
        except Exception as e:
            raise ModelError("модель не открылась: %s" % type(e).__name__)

    def _load(self, kind):
        if self.kind == kind:
            return
        self._drop()  # одновременно держим только одну половину
        if kind == "visual":
            self.session = self._open(("visual", "model.onnx"))
        else:
            tkp = self.cfg.path("textual", "tokenizer.json")
            if not os.path.isfile(tkp):
                raise ModelError("нет файла модели: textual/tokenizer.json")
            tok = Tokenizer.from_file(tkp)
            tok.enable_truncation(max_length=self.cfg.text_len)
            pad = tok.token_to_id("<pad>")
            tok.enable_padding(length=self.cfg.text_len, pad_id=0 if pad is None else pad, pad_token="<pad>")
            self.session = self._open(("textual", "model.onnx"))
            self.tok = tok
        self.kind = kind

    def _drop(self):
        had = self.session is not None
        self.session = None
        self.tok = None
        self.kind = None
        if had:
            trim_memory()

    def unload_if_idle(self):
        if time.monotonic() - self.last < self.cfg.idle_sec:
            return
        if self.lock.acquire(blocking=False):
            try:
                if self.session is not None and time.monotonic() - self.last >= self.cfg.idle_sec:
                    self._drop()
            finally:
                self.lock.release()

    def image(self, data):
        x = prep_image(data)
        with self.lock:
            self._load("visual")
            name = self.session.get_inputs()[0].name
            out = self.session.run(None, {name: x})[0]
            self.last = time.monotonic()
        v = unit(out)
        self.dim = len(v)
        return v

    def text(self, text):
        text = text.strip()
        if not text:
            raise InputError("пустой запрос")
        with self.lock:
            self._load("textual")
            inp = self.session.get_inputs()[0]
            ids = np.array([self.tok.encode(text).ids], dtype=np.int64 if "int64" in inp.type else np.int32)
            out = self.session.run(None, {inp.name: ids})[0]
            self.last = time.monotonic()
        v = unit(out)
        self.dim = len(v)
        return v


def make_handler(cfg, models):
    from http.server import BaseHTTPRequestHandler

    class H(BaseHTTPRequestHandler):
        server_version = "dvcloud-ml"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # без журнала запросов: в них нет ничего полезного, а запросы приватны
            pass

        def _send(self, code, obj):
            body = json.dumps(obj).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self, limit):
            n = self.headers.get("Content-Length")
            if n is None or not n.isdigit():
                raise InputError("нужен Content-Length")
            n = int(n)
            if n > limit:
                raise InputError("слишком большое тело запроса")
            return self.rfile.read(n)

        def do_GET(self):
            if self.path != "/health":
                return self._send(404, {"error": "нет такого адреса"})
            self._send(200, {"ok": True, "model": cfg.model_id, "ready": models.files_ready(), "loaded": models.kind, "dim": models.dim})

        def do_POST(self):
            try:
                if self.path == "/embed/image":
                    v = models.image(self._body(MAX_IMAGE_BYTES))
                elif self.path == "/embed/text":
                    try:
                        o = json.loads(self._body(64 * 1024))
                    except ValueError:
                        raise InputError("ожидался JSON")
                    t = o.get("text") if isinstance(o, dict) else None
                    if not isinstance(t, str) or len(t) > MAX_TEXT_CHARS:
                        raise InputError("text: строка до %d символов" % MAX_TEXT_CHARS)
                    v = models.text(t)
                else:
                    return self._send(404, {"error": "нет такого адреса"})
            except InputError as e:
                return self._send(400, {"error": str(e)})
            except ModelError as e:
                return self._send(503, {"error": str(e)})
            except Exception as e:
                return self._send(500, {"error": "сбой: %s" % type(e).__name__})
            self._send(200, {"model": cfg.model_id, "dim": len(v), "vector": encode(v)})

    return H


def serve(cfg=None):
    from http.server import ThreadingHTTPServer

    cfg = cfg or Config()
    models = Models(cfg)
    srv = ThreadingHTTPServer(("0.0.0.0", cfg.port), make_handler(cfg, models))
    srv.daemon_threads = True

    def sweeper():
        while True:
            time.sleep(min(5, max(1, cfg.idle_sec // 4)))
            models.unload_if_idle()

    threading.Thread(target=sweeper, daemon=True).start()
    print("dvcloud-ml: модель %s, порт %d, потоков %d" % (cfg.model_id, cfg.port, cfg.threads), flush=True)
    srv.serve_forever()


def selftest(cfg):
    """Проверка настоящей модели на сервере: файлы на месте, векторы разумные, русский текст совпадает с английским."""
    import resource

    m = Models(cfg)
    ok = True

    def check(name, cond, extra=""):
        nonlocal ok
        ok = ok and cond
        print(("  ДА   " if cond else "  НЕТ  ") + name + (" " + extra if extra else ""), flush=True)

    check("файлы модели на месте", m.files_ready())
    if not m.files_ready():
        return 1
    # Картинка-градиент: проверяем только размер вектора, смысл здесь не нужен.
    img = Image.new("RGB", (320, 240))
    img.putdata([(x % 256, (x // 3) % 256, 90) for x in range(320 * 240)])
    buf = io.BytesIO()
    img.save(buf, "JPEG")
    t0 = time.time()
    vi = m.image(buf.getvalue())
    check("вектор картинки", len(vi) >= 128 and abs(float(np.linalg.norm(vi)) - 1) < 1e-3, "длина %d, %.1f с (с загрузкой модели)" % (len(vi), time.time() - t0))
    t0 = time.time()
    pairs = [("кошка", "cat"), ("собака на пляже", "a dog on the beach"), ("кошка", "автомобиль")]
    vs = {}
    for a, b in pairs:
        for s in (a, b):
            if s not in vs:
                vs[s] = m.text(s)
    check("вектор текста", len(vs["кошка"]) == len(vi), "длина %d, %.1f с (с загрузкой модели)" % (len(vs["кошка"]), time.time() - t0))
    same = float(vs["кошка"] @ vs["cat"])
    same2 = float(vs["собака на пляже"] @ vs["a dog on the beach"])
    other = float(vs["кошка"] @ vs["автомобиль"])
    check("русский и английский рядом (кошка = cat)", same > other + 0.1, "%.2f против %.2f у «автомобиль»" % (same, other))
    check("русская фраза рядом с английской", same2 > 0.5, "%.2f" % same2)
    print("  память процесса: %d МБ" % (resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024))
    print("ИТОГ: " + ("всё в порядке" if ok else "ЕСТЬ ПРОБЛЕМЫ"))
    return 0 if ok else 1


if __name__ == "__main__":
    c = Config()
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        sys.exit(selftest(c))
    serve(c)
