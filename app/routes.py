from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import FileResponse, JSONResponse

from .config import STATIC_DIR, get_lan_candidates

router = APIRouter()


def index_response() -> FileResponse:
    response = FileResponse(STATIC_DIR / "index.html")
    # 模块化前端依赖浏览器每次都重新校验入口 HTML，否则发版后模块图可能命中旧缓存。
    response.headers["Cache-Control"] = "no-cache"
    return response


@router.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"ok": True})


# 供前端生成“扫码进房”二维码：返回本机可能的局域网 IPv4 候选列表。
@router.get("/api/lan")
async def lan_candidates() -> JSONResponse:
    response = JSONResponse({"candidates": get_lan_candidates()})
    response.headers["Cache-Control"] = "no-cache"
    return response


@router.get("/")
async def index() -> FileResponse:
    return index_response()


# 兼容旧书签：单页响应式改造后 /m 与 / 是同一个页面。
@router.get("/m")
async def mobile_index() -> FileResponse:
    return index_response()
