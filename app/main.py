from __future__ import annotations

from fastapi import FastAPI, WebSocket
from fastapi.staticfiles import StaticFiles

from .config import STATIC_DIR
from .hub import RoomHub
from .routes import router
from .signaling import signaling_socket

hub = RoomHub()
app = FastAPI(title="Web Transfer")
app.include_router(router)


class NoCacheStaticFiles(StaticFiles):
    """静态资源总是回源校验（配合 ETag 返回 304），替代旧的 ?v= 缓存参数。"""

    async def get_response(self, path: str, scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        response.headers.setdefault("Cache-Control", "no-cache")
        return response


app.mount("/static", NoCacheStaticFiles(directory=STATIC_DIR), name="static")


@app.websocket("/ws/signaling")
async def ws_signaling(websocket: WebSocket) -> None:
    await signaling_socket(websocket, hub)
