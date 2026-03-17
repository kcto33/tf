from __future__ import annotations

import os
import sys
from pathlib import Path

import uvicorn

from app.main import app


DEFAULT_PORT = int(os.getenv("WEB_TRANSFER_PORT", "8000"))


def parse_port_argument(default: int) -> int:
    if "--port" not in sys.argv:
        return default
    try:
        index = sys.argv.index("--port")
        return int(sys.argv[index + 1])
    except Exception:
        return default


def get_runtime_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def main() -> None:
    os.chdir(get_runtime_dir())
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=parse_port_argument(DEFAULT_PORT),
        log_level="warning",
        access_log=False,
    )


if __name__ == "__main__":
    main()
