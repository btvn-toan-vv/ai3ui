# mcp-adapter server image. Build context: this directory.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app

# Dependencies first so the layer caches across code changes.
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-install-project --no-dev

COPY src ./src
RUN uv sync --locked --no-dev

ENV PATH="/app/.venv/bin:$PATH" \
    SESSION_GRACE_SECONDS=60 \
    CALL_TIMEOUT_SECONDS=60 \
    LOG_LEVEL=info
# REDIS_URL is injected by compose; without it the in-memory store is used.

EXPOSE 8123

CMD ["uvicorn", "--factory", "mcp_adapter.server:create_app", "--host", "0.0.0.0", "--port", "8123"]
