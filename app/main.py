from __future__ import annotations

from fastapi import FastAPI, WebSocket
from fastapi.staticfiles import StaticFiles

from .config import STATIC_DIR
from .hub import hub
from .routes import router
from .signaling import signaling_socket

app = FastAPI(title="Web Transfer")
app.include_router(router)


class AppStaticFiles(StaticFiles):
    """静态资源响应增强：no-cache 回源校验；sw.js 允许根作用域注册。"""

    async def get_response(self, path: str, scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        response.headers.setdefault("Cache-Control", "no-cache")
        if path == "sw.js":
            # SW 位于 /static/ 下，默认作用域仅 /static/；放行根作用域以控制整个应用
            response.headers["Service-Worker-Allowed"] = "/"
        return response


app.mount("/static", AppStaticFiles(directory=STATIC_DIR), name="static")


@app.websocket("/ws/signaling")
async def ws_signaling(websocket: WebSocket) -> None:
    await signaling_socket(websocket, hub)
