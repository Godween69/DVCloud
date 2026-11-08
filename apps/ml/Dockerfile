# ML-сервис поиска по смыслу (apps/ml). Образ на обычном Linux (glibc): onnxruntime не работает на Alpine.
# Сборка: docker build -t dvcloud-ml:ТЕГ apps/ml
# Файлы модели в образ не кладутся: каталог с моделью монтируется только для чтения в /models (см. docs/SEARCH.md).
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DVML_MODEL_DIR=/models/model

# Версии зафиксированы: образ собирается одинаково сегодня и через год.
RUN pip install onnxruntime==1.29.0 numpy==2.5.3 pillow==12.3.0 tokenizers==0.23.3 \
    && useradd --system --uid 1000 --no-create-home --shell /usr/sbin/nologin ml

WORKDIR /app
COPY app.py .
USER ml
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=3)"]
CMD ["python", "-I", "app.py"]
