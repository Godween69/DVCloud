"""DV Cloud ML: векторы (эмбеддинги) картинок и текста для поиска по смыслу.

Маленький HTTP-сервис без внешних зависимостей, кроме onnxruntime, numpy, Pillow и tokenizers.
Работает только внутри закрытой сети Docker (без выхода в интернет), снаружи не виден.

  GET  /health        состояние: готовы ли файлы модели, что сейчас загружено в память
  POST /embed/image   тело: сама картинка (JPEG, PNG, WebP); ответ: вектор картинки
  POST /embed/text    тело: {"text": "собака на пляже"}; ответ: вектор текста
  POST /faces         тело: картинка; ответ: найденные лица (рамка в долях 0..1, оценка, вектор лица из 128 чисел)
  POST /pets          тело: картинка; ответ: найденные кошки и собаки (рамка, оценка, вектор как у поиска по смыслу)

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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # python -I не добавляет папку скрипта сам
import vision  # noqa: E402

Image.MAX_IMAGE_PIXELS = 60_000_000  # защита от «бомб»: огромных по размеру картинок

# Нормировка CLIP: средние и разброс по каналам RGB (одинаковые для OpenAI CLIP и OpenCLIP/LAION).
MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)
SIDE = 224
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_TEXT_CHARS = 1000
MAX_SIDE = 2560  # лица и питомцев ищем не на больше, чем такой картинке (крупнее уменьшаем)
MIN_FACE_PX = 36  # лицо меньше этого на уменьшенной картинке узнать нельзя
FACES_MODEL_ID = "yunet2023mar-sface2021dec"
PETS_MODEL_ID = "yolox-s"


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
        root = os.path.dirname(self.model_dir.rstrip("/"))
        self.faces_dir = os.environ.get("DVML_FACES_DIR", os.path.join(root, "faces"))  # yunet.onnx, sface.onnx
        self.pets_dir = os.environ.get("DVML_PETS_DIR", os.path.join(root, "pets"))  # yolox_s.onnx

    def path(self, *parts):
        return os.path.join(self.model_dir, *parts)


class ModelError(Exception):
    """Модель недоступна (нет файлов, не открылась)."""


class InputError(Exception):
    """Плохой вход: не картинка, пустой текст."""


def load_rgb(data, max_side=None):
    """Байты картинки -> RGB с учётом поворота по EXIF; при max_side слишком крупную уменьшает."""
    try:
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img).convert("RGB")
    except Exception as e:  # битый файл, неизвестный формат, слишком большая картинка
        raise InputError("картинка не читается: %s" % type(e).__name__)
    if max_side and max(img.size) > max_side:
        k = max_side / max(img.size)
        img = img.resize((max(1, round(img.size[0] * k)), max(1, round(img.size[1] * k))), Image.BILINEAR)
    return img


def prep_image(data):
    """Картинка -> тензор 1x3x224x224: короткая сторона до 224 (бикубика), обрезка по центру, нормировка."""
    return prep_pil(load_rgb(data))


def prep_pil(img):
    """RGB-картинка (PIL) -> тензор 1x3x224x224: обрезка по центру до квадрата, нормировка."""
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
        self.aux_kind = None  # "faces" | "pets" | None: отдельная группа сетей для лиц и питомцев
        self.aux = {}

    def faces_ready(self):
        return all(os.path.isfile(os.path.join(self.cfg.faces_dir, n)) for n in ("yunet.onnx", "sface.onnx"))

    def pets_ready(self):
        return os.path.isfile(os.path.join(self.cfg.pets_dir, "yolox_s.onnx")) and self.files_ready()

    def files_ready(self):
        c = self.cfg
        return all(os.path.isfile(c.path(*p)) for p in (("visual", "model.onnx"), ("textual", "model.onnx"), ("textual", "tokenizer.json")))

    def _open(self, rel, abs_path=None):
        path = abs_path or self.cfg.path(*rel)
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

    def _aux_load(self, group):
        if self.aux_kind == group:
            return
        self._aux_drop()
        if group == "faces":
            names = {"yunet": os.path.join(self.cfg.faces_dir, "yunet.onnx"), "sface": os.path.join(self.cfg.faces_dir, "sface.onnx")}
        else:
            names = {"yolox": os.path.join(self.cfg.pets_dir, "yolox_s.onnx")}
        self.aux = {k: self._open((group, os.path.basename(v)), v) for k, v in names.items()}
        self.aux_kind = group

    def _aux_drop(self):
        had = bool(self.aux)
        self.aux = {}
        self.aux_kind = None
        if had:
            trim_memory()

    def unload_if_idle(self):
        if time.monotonic() - self.last < self.cfg.idle_sec:
            return
        if self.lock.acquire(blocking=False):
            try:
                if (self.session is not None or self.aux) and time.monotonic() - self.last >= self.cfg.idle_sec:
                    self._drop()
                    self._aux_drop()
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

    def faces(self, data):
        """Лица на фото: [{box:[x,y,w,h] в долях картинки, score, vector}]. Рамки меньше MIN_FACE_PX не берём."""
        img = load_rgb(data, MAX_SIDE)
        W, H = img.size
        with self.lock:
            self._aux_load("faces")
            yn, sf = self.aux["yunet"], self.aux["sface"]
            out = []
            for f in vision.detect_faces(yn, img):
                if min(f["box"][2], f["box"][3]) < MIN_FACE_PX:
                    continue
                try:
                    v = vision.embed_face(sf, img, vision.refine_landmarks(yn, img, f))
                except ValueError:
                    continue
                x, y, w, h = f["box"]
                out.append({"box": [x / W, y / H, w / W, h / H], "score": round(f["score"], 4), "vector": encode(v)})
            self.last = time.monotonic()
        return out

    def pets(self, data):
        """Кошки и собаки на фото: [{kind, box (доли), score, vector}]. Вектор из той же модели CLIP, что и для поиска по смыслу."""
        img = load_rgb(data, MAX_SIDE)
        W, H = img.size
        with self.lock:
            self._aux_load("pets")
            found = vision.detect_pets(self.aux["yolox"], img)
            self.last = time.monotonic()
        out = []
        for p in found:
            crop = vision.crop_with_margin(img, p["box"])
            v = self.image_pil(crop)
            x, y, w, h = p["box"]
            out.append({"kind": p["kind"], "box": [x / W, y / H, w / W, h / H], "score": round(p["score"], 4), "vector": encode(v)})
        return out

    def image_pil(self, img):
        x = prep_pil(img)
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
            self._send(200, {
                "ok": True, "model": cfg.model_id, "ready": models.files_ready(), "loaded": models.kind or models.aux_kind, "dim": models.dim,
                "faces": {"ready": models.faces_ready(), "model": FACES_MODEL_ID},
                "pets": {"ready": models.pets_ready(), "model": PETS_MODEL_ID},
            })

        def do_POST(self):
            try:
                if self.path == "/embed/image":
                    v = models.image(self._body(MAX_IMAGE_BYTES))
                elif self.path == "/faces":
                    if not models.faces_ready():
                        raise ModelError("нет файлов модели лиц")
                    return self._send(200, {"model": FACES_MODEL_ID, "dim": 128, "faces": models.faces(self._body(MAX_IMAGE_BYTES))})
                elif self.path == "/pets":
                    if not models.pets_ready():
                        raise ModelError("нет файлов модели питомцев")
                    return self._send(200, {"model": PETS_MODEL_ID, "clip": cfg.model_id, "pets": models.pets(self._body(MAX_IMAGE_BYTES))})
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
    # Лица и питомцы (если файлы моделей положены): на пустой картинке не должно быть ни лиц, ни питомцев, а работа идти без сбоев.
    blank = io.BytesIO()
    Image.new("RGB", (1200, 800), (128, 128, 128)).save(blank, "JPEG")
    for title, ready, run in (("лица", m.faces_ready(), m.faces), ("питомцы", m.pets_ready(), m.pets)):
        if not ready:
            print("  --   %s: файлов модели нет (необязательно)" % title)
            continue
        t0 = time.time()
        try:
            found = run(blank.getvalue())
            check("%s: пустая картинка без находок" % title, found == [], "%.1f с (с загрузкой модели)" % (time.time() - t0))
        except Exception as e:  # noqa: BLE001
            check("%s: запуск" % title, False, type(e).__name__)
    print("  память процесса: %d МБ" % (resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024))
    print("ИТОГ: " + ("всё в порядке" if ok else "ЕСТЬ ПРОБЛЕМЫ"))
    return 0 if ok else 1


if __name__ == "__main__":
    c = Config()
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        sys.exit(selftest(c))
    serve(c)
