import asyncio
import json

from app.hub import ClientConnection, RoomHub


class FakeWebSocket:
    def __init__(self, name: str) -> None:
        self.name = name
        self.sent: list[str] = []
        self.closed = False

    async def send_text(self, data: str) -> None:
        if self.closed:
            raise RuntimeError("connection closed")
        self.sent.append(data)

    async def close(self) -> None:
        self.closed = True


def make_connection(client_id: str, room: str = "r1") -> tuple[ClientConnection, FakeWebSocket]:
    websocket = FakeWebSocket(client_id)
    return (
        ClientConnection(client_id=client_id, display_name=client_id, websocket=websocket, room_code=room),
        websocket,
    )


def run(coro):
    return asyncio.run(coro)


def test_join_lists_existing_peers_and_registers_newcomer():
    hub = RoomHub()
    conn_a, _ = make_connection("a")
    conn_b, ws_b = make_connection("b")
    run(hub.join("r1", "a", "Alice", conn_a.websocket))

    peers, replaced = run(hub.join("r1", "b", "Bob", ws_b))
    assert [peer["client_id"] for peer in peers] == ["a"]
    assert replaced is None
    assert hub.get_room_size("r1") == 2


def test_leave_requires_matching_websocket_identity():
    hub = RoomHub()
    conn_a, ws_a = make_connection("a")
    other_ws = FakeWebSocket("ghost")
    run(hub.join("r1", "a", "Alice", ws_a))

    assert run(hub.leave("r1", "a", other_ws)) is False
    assert hub.get_room_size("r1") == 1

    assert run(hub.leave("r1", "a", ws_a)) is True
    assert hub.get_room_size("r1") == 0


def test_leave_removes_empty_room():
    hub = RoomHub()
    conn, ws = make_connection("a")
    run(hub.join("r1", "a", "Alice", ws))
    run(hub.leave("r1", "a", ws))
    assert "r1" not in hub.rooms


def test_join_replaces_duplicate_client_id():
    hub = RoomHub()
    first_ws = FakeWebSocket("first")
    second_ws = FakeWebSocket("second")
    run(hub.join("r1", "a", "Alice", first_ws))
    _, replaced = run(hub.join("r1", "a", "Alice2", second_ws))

    assert replaced is not None
    assert replaced.websocket is first_ws
    assert hub.rooms["r1"]["a"].websocket is second_ws


def test_broadcast_excludes_sender_and_cleans_disconnected():
    hub = RoomHub()
    conn_a, ws_a = make_connection("a")
    conn_b, ws_b = make_connection("b")
    run(hub.join("r1", "a", "Alice", ws_a))
    run(hub.join("r1", "b", "Bob", ws_b))
    ws_b.closed = True

    run(hub.broadcast("r1", {"type": "peer_joined"}, exclude_client_id="a"))

    assert ws_a.sent == []
    # ws_b 已关闭：发送失败、消息未送达，且该连接会被移出房间
    assert ws_b.sent == []
    assert hub.get_room_size("r1") == 1


def test_send_to_offline_returns_false():
    hub = RoomHub()
    conn, ws = make_connection("a")
    run(hub.join("r1", "a", "Alice", ws))

    assert run(hub.send_to("r1", "missing", {"type": "ping"})) is False
    assert run(hub.send_to("r1", "a", {"type": "ping"})) is True
    assert json.loads(ws.sent[0])["type"] == "ping"
