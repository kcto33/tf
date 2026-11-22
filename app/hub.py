from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass
from typing import Any

from fastapi import WebSocket


@dataclass
class ClientConnection:
    client_id: str
    display_name: str
    websocket: WebSocket
    room_code: str


class RoomHub:
    """房间登记表：维护 room -> client_id -> 连接 的映射并负责定向/广播发送。"""

    def __init__(self) -> None:
        self.rooms: dict[str, dict[str, ClientConnection]] = defaultdict(dict)

    async def join(
        self, room_code: str, client_id: str, display_name: str, websocket: WebSocket
    ) -> tuple[list[dict[str, str]], ClientConnection | None]:
        room = self.rooms[room_code]
        peers = [
            {"client_id": peer.client_id, "display_name": peer.display_name}
            for peer in room.values()
        ]
        replaced = room.get(client_id)
        room[client_id] = ClientConnection(
            client_id=client_id,
            display_name=display_name,
            websocket=websocket,
            room_code=room_code,
        )
        return peers, replaced

    async def leave(self, room_code: str, client_id: str, websocket: WebSocket) -> bool:
        # 只有当登记的连接就是这条 websocket 时才移除，避免重复 client_id
        # 的旧连接断开时误删新连接。
        room = self.rooms.get(room_code)
        if not room:
            return False
        connection = room.get(client_id)
        if connection is None or connection.websocket is not websocket:
            return False
        room.pop(client_id, None)
        if not room:
            self.rooms.pop(room_code, None)
        return True

    async def broadcast(
        self, room_code: str, payload: dict[str, Any], exclude_client_id: str | None = None
    ) -> None:
        room = self.rooms.get(room_code, {})
        disconnected: list[str] = []
        for client_id, connection in room.items():
            if exclude_client_id and client_id == exclude_client_id:
                continue
            try:
                await connection.websocket.send_text(json.dumps(payload))
            except Exception:
                disconnected.append(client_id)
        for client_id in disconnected:
            connection = self.rooms.get(room_code, {}).get(client_id)
            if connection:
                await self.leave(room_code, client_id, connection.websocket)

    async def send_to(
        self, room_code: str, target_client_id: str, payload: dict[str, Any]
    ) -> bool:
        room = self.rooms.get(room_code, {})
        target = room.get(target_client_id)
        if target is None:
            return False
        try:
            await target.websocket.send_text(json.dumps(payload))
        except Exception:
            await self.leave(room_code, target_client_id, target.websocket)
            return False
        return True

    def get_room_size(self, room_code: str) -> int:
        return len(self.rooms.get(room_code, {}))

    def total_devices(self) -> int:
        return sum(len(room) for room in self.rooms.values())


# 模块级单例：路由与信令共享同一个房间登记表。
hub = RoomHub()
