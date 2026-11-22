from __future__ import annotations

import json

from fastapi import WebSocket, WebSocketDisconnect

from .config import MAX_SIGNAL_MESSAGE_BYTES
from .hub import RoomHub

# 这些消息类型要求携带 target_client_id，服务端只做定向转发，不解析内容。
FORWARDABLE_TYPES = {
    "webrtc_offer",
    "webrtc_answer",
    "ice_candidate",
    "transfer_request",
    "transfer_accept",
    "transfer_reject",
    "transfer_cancel",
    "transfer_abort",
    "resume_request",
    "resume_state",
    "relay_payload",
}


async def send_error(websocket: WebSocket, message: str) -> None:
    try:
        await websocket.send_text(json.dumps({"type": "error", "message": message}))
    except Exception:
        pass


async def signaling_socket(websocket: WebSocket, hub: RoomHub) -> None:
    await websocket.accept()
    room_code: str | None = None
    client_id: str | None = None

    try:
        while True:
            raw_message = await websocket.receive_text()
            if len(raw_message) > MAX_SIGNAL_MESSAGE_BYTES:
                await send_error(websocket, "Message too large.")
                continue

            try:
                message = json.loads(raw_message)
            except (json.JSONDecodeError, UnicodeDecodeError):
                await send_error(websocket, "Message must be valid JSON.")
                continue

            if not isinstance(message, dict):
                await send_error(websocket, "Message must be a JSON object.")
                continue

            message_type = message.get("type")

            if message_type == "join_room":
                room_code = str(message.get("room_code", "")).strip()
                client_id = str(message.get("client_id", "")).strip()
                if not room_code or not client_id:
                    await send_error(websocket, "join_room requires room_code and client_id.")
                    room_code = None
                    client_id = None
                    continue
                display_name = str(message.get("display_name") or "Anonymous").strip() or "Anonymous"
                peers, replaced = await hub.join(room_code, client_id, display_name, websocket)
                if replaced is not None:
                    # 同一 client_id 重连：断开旧连接。旧连接的清理逻辑会因
                    # 连接身份不匹配而跳过，不会影响新连接。
                    try:
                        await replaced.websocket.close(code=4000, reason="duplicate client id")
                    except Exception:
                        pass
                await websocket.send_text(
                    json.dumps(
                        {
                            "type": "joined_room",
                            "room_code": room_code,
                            "client_id": client_id,
                            "peers": peers,
                        }
                    )
                )
                await hub.broadcast(
                    room_code,
                    {
                        "type": "peer_joined",
                        "room_code": room_code,
                        "client_id": client_id,
                        "display_name": display_name,
                    },
                    exclude_client_id=client_id,
                )
                continue

            if room_code is None or client_id is None:
                await send_error(websocket, "join_room is required before other messages.")
                continue

            if message_type in FORWARDABLE_TYPES:
                target_client_id = message.get("target_client_id")
                if not target_client_id:
                    await send_error(websocket, f"{message_type} requires target_client_id.")
                    continue
                payload = {
                    **message,
                    "from_client_id": client_id,
                    "room_code": room_code,
                }
                sent = await hub.send_to(room_code, target_client_id, payload)
                if not sent:
                    await send_error(websocket, f"Target client {target_client_id} is offline.")
                continue

            await send_error(websocket, f"Unknown message: {message_type}")
    except WebSocketDisconnect:
        pass
    except json.JSONDecodeError:
        pass
    finally:
        if room_code and client_id:
            left = await hub.leave(room_code, client_id, websocket)
            if left:
                await hub.broadcast(
                    room_code,
                    {
                        "type": "peer_left",
                        "room_code": room_code,
                        "client_id": client_id,
                        "remaining_peers": hub.get_room_size(room_code),
                    },
                    exclude_client_id=client_id,
                )
