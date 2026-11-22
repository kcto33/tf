from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, WebSocket
from fastapi.staticfiles import StaticFiles

from .config import STATIC_DIR
from .hub import hub
from .routes import router
from .signaling import signaling_socket

app = FastAPI(title="Web Transfer")
app.include_router(router)

# 某些 Windows 环境（如 CI runner）通过注册表把 .js 注册成 text/plain，
# mimetypes.add_type 在这些环境不可靠——浏览器会拒绝加载模块脚本。
# 因此在响应头层面按扩展名强制正确的 Content-Type。
STATIC_MIME_OVERRIDES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".webmanifest": "application/manifest+json",
    ".png": "image/png",
}


class AppStaticFiles(StaticFiles):
    """静态资源响应增强：强制 MIME、no-cache 回源校验；sw.js 允许根作用域注册。"""

    async def get_response(self, path: str, scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        suffix = Path(path).suffix.lower()
        if suffix in STATIC_MIME_OVERRIDES:
            response.headers["content-type"] = STATIC_MIME_OVERRIDES[suffix]
        response.headers.setdefault("Cache-Control", "no-cache")
        if path == "sw.js":
            # SW 位于 /static/ 下，默认作用域仅 /static/；放行根作用域以控制整个应用
            response.headers["Service-Worker-Allowed"] = "/"
        return response


app.mount("/static", AppStaticFiles(directory=STATIC_DIR), name="static")


@app.websocket("/ws/signaling")
async def ws_signaling(websocket: WebSocket) -> None:
    await signaling_socket(websocket, hub)
