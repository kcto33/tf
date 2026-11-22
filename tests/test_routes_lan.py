from fastapi.testclient import TestClient

from app.config import get_lan_candidates
from app.main import app

client = TestClient(app)


def test_lan_candidates_endpoint():
    response = client.get("/api/lan")
    assert response.status_code == 200
    data = response.json()
    candidates = data["candidates"]
    for candidate in candidates:
        ip = candidate["ip"] if isinstance(candidate, dict) else candidate
        assert not ip.startswith(("127.", "169.254.", "198.18.", "198.19."))
        if isinstance(candidate, dict):
            assert isinstance(candidate["interface"], str)
    assert response.headers.get("cache-control") == "no-cache"


def test_lan_candidates_skip_virtual_adapters():
    # 本机通常存在回环/链路本地/代理 TUN 虚拟网卡，候选必须全部排除它们；
    # 若存在真实物理网卡（WLAN/以太网），应排在最前。
    candidates = get_lan_candidates()
    ips = [item["ip"] for item in candidates]
    for ip in ips:
        assert not ip.startswith(("127.", "169.254.", "198.18.", "198.19."))
    wlan_like = [item for item in candidates if item["interface"].lower().find("wlan") >= 0 or "以太网" in item["interface"]]
    if wlan_like:
        assert candidates.index(wlan_like[0]) == 0


def test_index_still_served():
    response = client.get("/")
    assert response.status_code == 200
    assert "文件传输" in response.text
