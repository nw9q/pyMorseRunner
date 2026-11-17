FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8073 \
    HOST=0.0.0.0

WORKDIR /app

# Create unprivileged runtime user
RUN groupadd --gid 10001 appuser && \
    useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin appuser

# Copy application source and static frontend assets (owned by root, read-only to appuser)
COPY --chown=root:root app.py ./
COPY --chown=root:root static/ ./static/
RUN chmod 0755 /app /app/static && \
    chmod 0644 /app/app.py /app/static/* && \
    mkdir -p /app/data && \
    chown -R appuser:appuser /app/data && \
    chmod 0750 /app/data

USER appuser
EXPOSE 8073

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8073/healthz', timeout=3)" || exit 1

CMD ["python3", "app.py"]
