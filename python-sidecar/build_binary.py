"""Bundle the worker into a single self-contained binary via PyInstaller.

Output goes to ``dist/worker-<target-triple>``. Tauri picks it up via
``externalBin`` in ``tauri.conf.json``.

Tauri's ``externalBin`` requires an exact triple suffix (e.g.
``aarch64-apple-darwin``) matching the host's rustc target. We probe rustc
to read the host triple at build time so the produced filename always
matches whatever Tauri is about to look for.

Usage::

    cd python-sidecar
    uv run python build_binary.py

Requires ``pyinstaller`` to be installed in the venv (added on demand
below if missing).
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ENTRY = ROOT / "_pyinstaller_entry.py"
SPEC = ROOT / "worker.spec"
DIST = ROOT / "dist"
BUILD = ROOT / "build"

ENTRY_SOURCE = """\
# Auto-generated entry point. Don't edit by hand.
# PyInstaller can't import a module via ``-m`` directly, so we wrap
# ``worker.main:main()`` in a tiny shim and point the bundler at this file.
import sys
from worker.main import main


if __name__ == "__main__":
    sys.exit(main())
"""


def host_triple() -> str:
    out = subprocess.check_output(["rustc", "-vV"], text=True)
    for line in out.splitlines():
        if line.startswith("host:"):
            return line.split(":", 1)[1].strip()
    raise RuntimeError("could not parse host triple from `rustc -vV`")


def ensure_pyinstaller() -> None:
    try:
        import PyInstaller  # noqa: F401
        return
    except ModuleNotFoundError:
        pass
    print("[build] installing pyinstaller…")
    # uv-managed venvs ship without pip on purpose. Use `uv pip install`
    # instead — it auto-discovers the venv from `VIRTUAL_ENV` (set when this
    # script runs under `uv run`) or by walking up looking for `.venv`.
    if shutil.which("uv"):
        subprocess.check_call(["uv", "pip", "install", "pyinstaller>=6.10"], cwd=str(ROOT))
        return
    # Fallback for non-uv envs that DO have pip.
    subprocess.check_call(
        [sys.executable, "-m", "pip", "install", "pyinstaller>=6.10"]
    )


def write_entry() -> None:
    if ENTRY.exists() and ENTRY.read_text() == ENTRY_SOURCE:
        return
    ENTRY.write_text(ENTRY_SOURCE)


def clean() -> None:
    for d in (DIST, BUILD):
        if d.exists():
            shutil.rmtree(d)
    if SPEC.exists():
        SPEC.unlink()


def build(triple: str) -> Path:
    name = f"worker-{triple}"
    print(f"[build] PyInstaller -> {name}")
    # `--collect-all faster_whisper` and friends pull every data file the
    # libraries need at runtime (CTranslate2 .so, tokenizers vocab, etc.).
    # Without these PyInstaller silently strips them and the binary crashes
    # on first transcribe.
    subprocess.check_call([
        sys.executable, "-m", "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--name", name,
        "--collect-all", "faster_whisper",
        "--collect-all", "ctranslate2",
        "--collect-all", "av",
        "--collect-all", "onnxruntime",
        "--collect-all", "tokenizers",
        "--collect-submodules", "uvicorn",
        "--hidden-import", "uvicorn.lifespan.on",
        "--hidden-import", "uvicorn.lifespan.off",
        "--hidden-import", "uvicorn.protocols.websockets.auto",
        "--hidden-import", "uvicorn.protocols.http.auto",
        "--hidden-import", "uvicorn.loops.auto",
        str(ENTRY),
    ])
    out = DIST / name
    if not out.exists():
        # On Windows PyInstaller appends `.exe`. Tauri's externalBin
        # convention also wants the suffix when targeting Windows.
        candidate = DIST / f"{name}.exe"
        if candidate.exists():
            out = candidate
    if not out.exists():
        raise RuntimeError(f"build failed — {out} not produced")
    return out


def stage_for_tauri(binary: Path, triple: str) -> Path:
    """Copy the built binary into ``src-tauri/binaries/`` where Tauri's
    ``externalBin`` expects to find it (filename `worker-<triple>` with the
    OS-appropriate extension)."""
    target_dir = ROOT.parent / "src-tauri" / "binaries"
    target_dir.mkdir(parents=True, exist_ok=True)
    suffix = ".exe" if binary.suffix == ".exe" else ""
    target = target_dir / f"worker-{triple}{suffix}"
    shutil.copy2(binary, target)
    # Preserve the executable bit on Unix.
    target.chmod(target.stat().st_mode | 0o111)
    return target


def main() -> int:
    triple = host_triple()
    ensure_pyinstaller()
    write_entry()
    clean()
    out = build(triple)
    staged = stage_for_tauri(out, triple)
    print(f"[build] OK: {out}")
    print(f"[build] Staged for Tauri: {staged}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
