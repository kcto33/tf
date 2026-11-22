from fastapi.testclient import TestClient

from app.hub import hub
from app.main import app

client = TestClient(app)


def test_status_reports_device_count_and_rooms():
    hub.rooms.clear()
    with client.websocket_connect("/ws/signaling") as first:
        first.send_json({"type": "join_room", "room_code": "r", "client_id": "a", "display_name": "甲"})
        first.receive_json()

        status = client.get("/api/status").json()
        assert status["total_devices"] == 1
        assert status["rooms"] == {"r": 1}

        with client.websocket_connect("/ws/signaling") as second:
            second.send_json({"type": "join_room", "room_code": "r", "client_id": "b", "display_name": "乙"})
            second.receive_json()
            assert client.get("/api/status").json()["total_devices"] == 2

        # 乙断开后设备数回 1
        assert client.get("/api/status").json()["total_devices"] == 1

    hub.rooms.clear()


def test_status_empty_when_no_devices():
    hub.rooms.clear()
    status = client.get("/api/status").json()
    assert status["total_devices"] == 0
    assert status["rooms"] == {}
    assert client.get("/api/status").headers.get("cache-control") == "no-cache"
