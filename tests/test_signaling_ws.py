import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.main import app, hub


@pytest.fixture()
def client():
    hub.rooms.clear()
    with TestClient(app) as test_client:
        yield test_client
    hub.rooms.clear()


def join(client, room="room-1", client_id="client-a", display_name="Alice"):
    ws = client.websocket_connect("/ws/signaling")
    socket = ws.__enter__()
    socket.send_json(
        {"type": "join_room", "room_code": room, "client_id": client_id, "display_name": display_name}
    )
    return ws, socket


def test_join_room_returns_peer_list(client):
    ws, socket = join(client)
    try:
        reply = socket.receive_json()
        assert reply["type"] == "joined_room"
        assert reply["room_code"] == "room-1"
        assert reply["client_id"] == "client-a"
        assert reply["peers"] == []
    finally:
        ws.__exit__(None, None, None)


def test_second_client_receives_peer_joined_and_sees_existing_peer(client):
    first_ws, first = join(client, client_id="a", display_name="Alice")
    first.receive_json()  # joined_room

    second_ws, second = join(client, client_id="b", display_name="Bob")
    try:
        reply = second.receive_json()
        assert reply["type"] == "joined_room"
        assert [(p["client_id"], p["display_name"]) for p in reply["peers"]] == [("a", "Alice")]

        event = first.receive_json()
        assert event["type"] == "peer_joined"
        assert event["client_id"] == "b"
    finally:
        second_ws.__exit__(None, None, None)
        first_ws.__exit__(None, None, None)


def test_transfer_request_is_forwarded_with_sender_identity(client):
    first_ws, first = join(client, client_id="a")
    first.receive_json()
    second_ws, second = join(client, client_id="b")
    second.receive_json()
    first.receive_json()  # peer_joined b

    try:
        first.send_json(
            {
                "type": "transfer_request",
                "target_client_id": "b",
                "session_id": "s1",
                "total_size": 10,
                "files": [],
            }
        )
        event = second.receive_json()
        assert event["type"] == "transfer_request"
        assert event["session_id"] == "s1"
        assert event["from_client_id"] == "a"
        assert event["room_code"] == "room-1"
    finally:
        second_ws.__exit__(None, None, None)
        first_ws.__exit__(None, None, None)


def test_forward_without_target_returns_error(client):
    ws, socket = join(client, client_id="a")
    try:
        socket.receive_json()
        socket.send_json({"type": "transfer_request", "session_id": "s1"})
        reply = socket.receive_json()
        assert reply["type"] == "error"
        assert "target_client_id" in reply["message"]
    finally:
        ws.__exit__(None, None, None)


def test_message_before_join_is_rejected(client):
    with client.websocket_connect("/ws/signaling") as socket:
        socket.send_json({"type": "transfer_request", "target_client_id": "x"})
        reply = socket.receive_json()
        assert reply["type"] == "error"
        assert "join_room" in reply["message"]


def test_unknown_message_type_returns_error(client):
    ws, socket = join(client, client_id="a")
    try:
        socket.receive_json()
        socket.send_json({"type": "mystery"})
        reply = socket.receive_json()
        assert reply["type"] == "error"
        assert "mystery" in reply["message"]
    finally:
        ws.__exit__(None, None, None)


def test_invalid_json_returns_error_without_closing(client):
    ws, socket = join(client, client_id="a")
    try:
        socket.receive_json()
        socket.send_text("this is not json")
        reply = socket.receive_json()
        assert reply["type"] == "error"
        assert "JSON" in reply["message"]

        # 连接保持可用
        socket.send_json({"type": "mystery"})
        reply = socket.receive_json()
        assert reply["type"] == "error"
    finally:
        ws.__exit__(None, None, None)


def test_non_object_json_returns_error(client):
    ws, socket = join(client, client_id="a")
    try:
        socket.receive_json()
        socket.send_text("[1, 2, 3]")
        reply = socket.receive_json()
        assert reply["type"] == "error"
        assert "object" in reply["message"]
    finally:
        ws.__exit__(None, None, None)


def test_join_room_requires_fields(client):
    with client.websocket_connect("/ws/signaling") as socket:
        socket.send_json({"type": "join_room", "room_code": "", "client_id": ""})
        reply = socket.receive_json()
        assert reply["type"] == "error"
        assert "room_code" in reply["message"]


def test_disconnect_broadcasts_peer_left(client):
    first_ws, first = join(client, client_id="a")
    first.receive_json()
    second_ws, second = join(client, client_id="b")
    second.receive_json()
    first.receive_json()

    first_ws.__exit__(None, None, None)

    event = second.receive_json()
    assert event["type"] == "peer_left"
    assert event["client_id"] == "a"
    assert event["remaining_peers"] == 1
    second_ws.__exit__(None, None, None)


def test_duplicate_client_id_closes_old_connection(client):
    first_ws, first = join(client, client_id="dup", display_name="First")
    first.receive_json()

    second_ws, second = join(client, client_id="dup", display_name="Second")
    try:
        second.receive_json()

        # 旧连接被服务端主动断开
        with pytest.raises(WebSocketDisconnect):
            first.receive_json()
    finally:
        second_ws.__exit__(None, None, None)
        first_ws.__exit__(None, None, None)


def test_stale_duplicate_connection_does_not_remove_new_one(client):
    first_ws, first = join(client, client_id="dup", display_name="First")
    first.receive_json()

    second_ws, second = join(client, client_id="dup", display_name="Second")
    second.receive_json()
    first_ws.__exit__(None, None, None)

    # 旧连接断开不应把新连接挤出房间：新连接仍能收到 peer 消息
    third_ws, third = join(client, client_id="c", display_name="Third")
    try:
        reply = third.receive_json()
        assert [(p["client_id"]) for p in reply["peers"]] == ["dup"]
    finally:
        third_ws.__exit__(None, None, None)
        second_ws.__exit__(None, None, None)
