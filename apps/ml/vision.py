"""DV Cloud ML: лица и питомцы на фото (только numpy и Pillow, сами нейросети идут через onnxruntime).

Лица: YuNet находит лицо и пять точек (глаза, нос, уголки рта), SFace превращает выровненное лицо в вектор из
128 чисел. Векторы одного человека близки (скалярное произведение двух нормированных векторов выше порога),
разных людей далеки. Лицензии: YuNet MIT, SFace Apache-2.0 (набор opencv_zoo).

Питомцы: YOLOX-s (Apache-2.0) находит кошек и собак среди 80 классов COCO; вектор для узнавания даёт та же
картиночная модель CLIP, что и в поиске по смыслу (она передаётся снаружи), по вырезанному кадру.

Здесь нет ни сети, ни файлов модели: функции получают уже открытые сессии onnxruntime. Всё считается в пикселях
картинки; наружу координаты отдаёт app.py уже в долях от размеров (0..1).
"""
import math

import numpy as np
from PIL import Image

NET = 640  # обе сети работают с квадратом 640x640

# Эталонное расположение пяти точек на лице 112x112 (как в ArcFace/SFace): правый глаз, левый глаз, нос, уголки рта.
FACE_TEMPLATE = np.array(
    [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float64
)

COCO_CAT, COCO_DOG = 15, 16  # номера классов в COCO (с нуля): кошка, собака


def _bgr_chw(img, size=None, fill=114):
    """RGB-картинка -> тензор 1x3xNxN в порядке BGR, значения 0..255. Если задан size: вписать с сохранением пропорций
    в левый верхний угол, остальное залить серым. Возвращает (тензор, коэффициент уменьшения)."""
    if size is None:
        a = np.asarray(img, dtype=np.float32)
        return np.ascontiguousarray(a[:, :, ::-1].transpose(2, 0, 1)[None, ...]), 1.0
    w, h = img.size
    k = min(size / w, size / h)
    nw, nh = max(1, int(round(w * k))), max(1, int(round(h * k)))
    small = img.resize((nw, nh), Image.BILINEAR)
    canvas = np.full((size, size, 3), fill, dtype=np.float32)
    canvas[:nh, :nw, :] = np.asarray(small, dtype=np.float32)
    return np.ascontiguousarray(canvas[:, :, ::-1].transpose(2, 0, 1)[None, ...]), k


def nms(boxes, scores, thr):
    """Подавление дублей: оставить лучшие рамки, у которых пересечение с уже взятыми не больше thr. boxes: Nx4 (x1,y1,x2,y2)."""
    order = np.argsort(-scores)
    keep = []
    while order.size:
        i = order[0]
        keep.append(int(i))
        if order.size == 1:
            break
        rest = order[1:]
        xx1 = np.maximum(boxes[i, 0], boxes[rest, 0])
        yy1 = np.maximum(boxes[i, 1], boxes[rest, 1])
        xx2 = np.minimum(boxes[i, 2], boxes[rest, 2])
        yy2 = np.minimum(boxes[i, 3], boxes[rest, 3])
        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        a_i = (boxes[i, 2] - boxes[i, 0]) * (boxes[i, 3] - boxes[i, 1])
        a_r = (boxes[rest, 2] - boxes[rest, 0]) * (boxes[rest, 3] - boxes[rest, 1])
        iou = inter / np.maximum(a_i + a_r - inter, 1e-9)
        order = rest[iou <= thr]
    return keep


# ---------------------------------------------------------------- лица

def _yunet_decode(outs, thr):
    """Выходы YuNet (три масштаба) -> кандидаты: x1,y1,x2,y2, оценка, пять точек (в пикселях квадрата 640)."""
    cls, obj, bbox, kps = outs[0:3], outs[3:6], outs[6:9], outs[9:12]
    res = []
    for n, stride in enumerate((8, 16, 32)):
        cols = NET // stride
        c = np.clip(cls[n][0, :, 0], 0, 1)
        o = np.clip(obj[n][0, :, 0], 0, 1)
        score = np.sqrt(c * o)
        idx = np.nonzero(score >= thr)[0]
        if idx.size == 0:
            continue
        r, q = idx // cols, idx % cols
        b, k = bbox[n][0][idx], kps[n][0][idx]
        cx, cy = (q + b[:, 0]) * stride, (r + b[:, 1]) * stride
        w, h = np.exp(b[:, 2]) * stride, np.exp(b[:, 3]) * stride
        lm = np.stack([np.stack([(k[:, 2 * j] + q) * stride, (k[:, 2 * j + 1] + r) * stride], axis=1) for j in range(5)], axis=1)
        box = np.stack([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], axis=1)
        for i in range(idx.size):
            res.append((box[i], float(score[idx[i]]), lm[i]))
    return res


def _windows(w, h, side=NET, step=NET - 96):
    """Окна side x side, которые покрывают картинку с перекрытием (для мелких лиц на больших фото)."""
    xs = list(range(0, max(w - side, 0) + 1, step))
    ys = list(range(0, max(h - side, 0) + 1, step))
    if xs[-1] + side < w:
        xs.append(w - side)
    if ys[-1] + side < h:
        ys.append(h - side)
    return [(x, y) for y in ys for x in xs]


def detect_faces(sess, img, thr=0.8, max_faces=40):
    """Найти лица. Картинка один раз целиком (вписана в 640) и, если она крупнее, по окнам 640x640 в масштабе, где
    длинная сторона не больше 1280 (так находятся и мелкие лица). Возвращает список
    {box:[x,y,w,h], score, lm:[[x,y]x5]} в пикселях исходной картинки."""
    W, H = img.size
    cands = []  # (x1,y1,x2,y2, score, lm) в координатах исходной картинки

    k_full = min(NET / W, NET / H)
    x, _ = _bgr_chw(img, NET)
    outs = sess.run(None, {sess.get_inputs()[0].name: x})
    for box, sc, lm in _yunet_decode(outs, thr):
        cands.append((box / k_full, sc, lm / k_full))
    long_side = max(W, H)
    if long_side > NET * 1.3:
        s = min(1.0, 1280 / long_side)  # масштаб для окон
        big = img if s >= 0.999 else img.resize((max(1, int(round(W * s))), max(1, int(round(H * s)))), Image.BILINEAR)
        bw, bh = big.size
        for (ox, oy) in _windows(bw, bh):
            tile = big.crop((ox, oy, min(ox + NET, bw), min(oy + NET, bh)))
            x, _ = _bgr_chw(tile, NET)  # окно вписывается без уменьшения (крайние окна могут быть меньше 640: дополняются)
            outs = sess.run(None, {sess.get_inputs()[0].name: x})
            for box, sc, lm in _yunet_decode(outs, thr):
                off = np.array([ox, oy], dtype=np.float64)
                cands.append((np.concatenate([box[:2] + off, box[2:] + off]) / s, sc, (lm + off) / s))
    if not cands:
        return []
    boxes = np.stack([c[0] for c in cands])
    scores = np.array([c[1] for c in cands])
    keep = nms(boxes, scores, 0.3)[:max_faces]
    out = []
    for i in keep:
        x1, y1, x2, y2 = boxes[i]
        x1, y1, x2, y2 = max(0.0, x1), max(0.0, y1), min(float(W), x2), min(float(H), y2)
        if x2 - x1 < 8 or y2 - y1 < 8:
            continue
        out.append({"box": [float(x1), float(y1), float(x2 - x1), float(y2 - y1)], "score": float(scores[i]), "lm": cands[i][2].tolist()})
    return out


def refine_landmarks(sess, img, face, face_px=160):
    """Точки лица точнее: вырезаем окно вокруг найденного лица, приводим лицо к стандартному размеру (около face_px)
    и ещё раз запускаем YuNet. Тогда точки не зависят от размера фото (на сильно уменьшенных кадрах они плывут).
    Если повторно лицо не нашлось, остаются прежние точки."""
    x, y, w, h = face["box"]
    k = face_px / max(w, h, 1.0)
    cx, cy = x + w / 2, y + h / 2
    half = NET / (2 * k)  # половина стороны окна в пикселях исходной картинки
    x0, y0 = cx - half, cy - half
    win = img.transform((NET, NET), Image.AFFINE, (1 / k, 0, x0, 0, 1 / k, y0), resample=Image.BILINEAR, fillcolor=(114, 114, 114))
    xin, _ = _bgr_chw(win, NET)
    outs = sess.run(None, {sess.get_inputs()[0].name: xin})
    best, best_iou = None, 0.3
    for box, sc, lm in _yunet_decode(outs, 0.5):
        b = [x0 + box[0] / k, y0 + box[1] / k, (box[2] - box[0]) / k, (box[3] - box[1]) / k]
        v = _iou(b, face["box"])
        if v > best_iou:
            best, best_iou = (x0 + lm[:, 0] / k, y0 + lm[:, 1] / k), v
    if best is None:
        return face["lm"]
    return np.stack(best, axis=1).tolist()


def _similarity(src, dst):
    """Матрица 2x3 преобразования подобия (поворот, масштаб, сдвиг), переводящая точки src в dst (метод Умеямы)."""
    src, dst = np.asarray(src, dtype=np.float64), np.asarray(dst, dtype=np.float64)
    ms, md = src.mean(0), dst.mean(0)
    s0, d0 = src - ms, dst - md
    var = (s0 ** 2).sum() / len(src)
    u, sig, vt = np.linalg.svd(d0.T @ s0 / len(src))
    sgn = np.ones(2)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        sgn[1] = -1
    rot = u @ np.diag(sgn) @ vt
    scale = (sig * sgn).sum() / max(var, 1e-12)
    t = md - scale * rot @ ms
    return np.hstack([scale * rot, t[:, None]])


def align_face(img, lm):
    """Вырезать лицо 112x112, выровняв по пяти точкам."""
    m = _similarity(np.asarray(lm, dtype=np.float64), FACE_TEMPLATE)
    full = np.vstack([m, [0, 0, 1]])
    inv = np.linalg.inv(full)
    coeffs = (inv[0, 0], inv[0, 1], inv[0, 2], inv[1, 0], inv[1, 1], inv[1, 2])
    return img.transform((112, 112), Image.AFFINE, coeffs, resample=Image.BILINEAR)


def embed_face(sess, img, lm):
    """Вектор лица: 128 чисел, нормирован (длина 1)."""
    crop = align_face(img, lm)
    x = np.ascontiguousarray(np.asarray(crop, dtype=np.float32).transpose(2, 0, 1)[None, ...])  # RGB, 0..255
    v = np.asarray(sess.run(None, {sess.get_inputs()[0].name: x})[0], dtype=np.float64).reshape(-1)
    n = np.linalg.norm(v)
    if not np.isfinite(n) or n == 0:
        raise ValueError("пустой вектор лица")
    return (v / n).astype("<f4")


# ---------------------------------------------------------------- питомцы

def _grids():
    gs, ss = [], []
    for stride in (8, 16, 32):
        n = NET // stride
        xv, yv = np.meshgrid(np.arange(n), np.arange(n))
        gs.append(np.stack((xv, yv), 2).reshape(-1, 2))
        ss.append(np.full((n * n, 1), stride))
    return np.concatenate(gs, 0).astype(np.float32), np.concatenate(ss, 0).astype(np.float32)


_GRID = _grids()


def detect_pets(sess, img, thr=0.4, max_pets=10):
    """Найти кошек и собак. Возвращает [{kind:'cat'|'dog', box:[x,y,w,h], score}] в пикселях исходной картинки."""
    W, H = img.size
    x, k = _bgr_chw(img, NET)
    out = sess.run(None, {sess.get_inputs()[0].name: x})[0][0].astype(np.float32)
    grid, stride = _GRID
    xy = (out[:, 0:2] + grid) * stride
    wh = np.exp(out[:, 2:4]) * stride
    obj = out[:, 4]
    cls = out[:, 5:]
    res = []
    for kind, cid in (("cat", COCO_CAT), ("dog", COCO_DOG)):
        sc = obj * cls[:, cid]
        idx = np.nonzero(sc >= thr)[0]
        if idx.size == 0:
            continue
        b = np.stack([xy[idx, 0] - wh[idx, 0] / 2, xy[idx, 1] - wh[idx, 1] / 2, xy[idx, 0] + wh[idx, 0] / 2, xy[idx, 1] + wh[idx, 1] / 2], 1) / k
        for j in nms(b, sc[idx], 0.45):
            x1, y1, x2, y2 = b[j]
            x1, y1, x2, y2 = max(0.0, x1), max(0.0, y1), min(float(W), x2), min(float(H), y2)
            if x2 - x1 < 24 or y2 - y1 < 24:
                continue
            res.append({"kind": kind, "box": [float(x1), float(y1), float(x2 - x1), float(y2 - y1)], "score": float(sc[idx][j])})
    res.sort(key=lambda r: -r["score"])
    # кошка и собака на одном месте: оставляем более уверенное
    kept = []
    for r in res:
        bx = r["box"]
        if any(_iou(bx, o["box"]) > 0.6 for o in kept):
            continue
        kept.append(r)
    return kept[:max_pets]


def _iou(a, b):
    ax2, ay2, bx2, by2 = a[0] + a[2], a[1] + a[3], b[0] + b[2], b[1] + b[3]
    iw = max(0.0, min(ax2, bx2) - max(a[0], b[0]))
    ih = max(0.0, min(ay2, by2) - max(a[1], b[1]))
    inter = iw * ih
    return inter / max(a[2] * a[3] + b[2] * b[3] - inter, 1e-9)


def crop_with_margin(img, box, margin=0.1):
    """Вырезать рамку с небольшим запасом по краям (животное целиком, без обрезанных ушей и хвоста)."""
    W, H = img.size
    x, y, w, h = box
    mx, my = w * margin, h * margin
    return img.crop((int(max(0, x - mx)), int(max(0, y - my)), int(min(W, x + w + mx)), int(min(H, y + h + my))))
