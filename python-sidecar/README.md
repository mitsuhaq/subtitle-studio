# Subtitle Studio — Python sidecar

Whisper + FFmpeg worker spawned by the Tauri app.

## Dev

```sh
cd python-sidecar
uv sync                        # creates .venv, installs deps
uv run python -m worker.main   # WORKER_READY <port>
```

Heavyweight deps (`faster-whisper`, `torch`) are not pinned in step 1 to
keep the first scaffold quick — they will be added on step 2 / 3. The
current entry point only starts a FastAPI `/health` endpoint, enough to
verify the spawn handshake from the Rust side.
