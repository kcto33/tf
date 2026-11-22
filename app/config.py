from __future__ import annotations

import mimetypes
import socket
import sys
from pathlib import Path

try:
    import psutil
except ImportError:  # pragma: no cover - psutil 缺失时退回 socket 探测
    psutil = None


def get_runtime_base_dir() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent.parent


BASE_DIR = get_runtime_base_dir()
STATIC_DIR = BASE_DIR / "static"

# Some Windows machines register `.js` as `text/plain`, which breaks
# `<script type="module">` loading in browsers. Force stable MIME types.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")

# 信令单条消息上限：中继二进制以 base64 走这条通道，256KB 分块编码后约 350KB，
# 4MB 上限足以容纳最大合法消息，同时防住异常巨型帧。
MAX_SIGNAL_MESSAGE_BYTES = 4 * 1024 * 1024


def get_lan_candidates() -> list[dict[str, str]]:
    """枚举本机可用的局域网 IPv4 地址，供二维码/分享链接挑选。

    返回按可用性排序的 ``{"ip", "interface"}`` 列表：
    - psutil 可用时按网卡枚举（能拿到接口名），否则退回 UDP 出口探测 + 主机名解析；
    - 过滤回环、链路本地（169.254.*）、基准测试网段（198.18.0.0/15，代理 TUN 虚拟网卡）
      和明显的虚拟接口（Hyper-V/WSL/Docker/VPN 等）；
    - 只保留私网地址（局域网工具的二维码必须是对方可达的内网地址）；
    - 常见物理网卡（WLAN/以太网/Ethernet 等）排最前。
    """
    entries: dict[str, str] = {}

    if psutil is not None:
        for interface, addrs in psutil.net_if_addrs().items():
            for addr in addrs:
                if addr.family != socket.AF_INET:
                    continue
                entries.setdefault(addr.address, interface)

    if not entries:
        for probe in ("8.8.8.8", "114.114.114.114", "223.5.5.5"):
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                    sock.settimeout(0.2)
                    sock.connect((probe, 53))
                    entries.setdefault(sock.getsockname()[0], "")
            except OSError:
                continue
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                entries.setdefault(info[4][0], "")
        except socket.gaierror:
            pass

    def rank(ip: str, interface: str) -> int | None:
        lowered = interface.lower()
        if ip.startswith(("127.", "169.254.", "0.")):
            return None
        if ip.startswith("198.18.") or ip.startswith("198.19."):
            return None
        # 只保留私网段
        private = (
            ip.startswith("192.168.")
            or ip.startswith("10.")
            or (ip.startswith("172.") and 16 <= int(ip.split(".")[1]) <= 31)
        )
        if not private:
            return None
        # 排除常见虚拟/代理接口
        virtual_hints = (
            "tun", "tap", "mihomo", "clash", "vpn", "wireguard", "openvpn",
            "vethernet", "hyper-v", "wsl", "docker", "vmware", "virtualbox",
            "loopback", "bluetooth", "蓝牙",
        )
        if any(hint in lowered for hint in virtual_hints):
            return None
        lan_hints = ("wlan", "wi-fi", "wifi", "以太网", "ethernet", "本地连接", "eth", "en0")
        if any(hint in lowered for hint in lan_hints):
            return 0
        return 1

    ranked: list[tuple[int, str, str]] = []
    for ip, interface in entries.items():
        order = rank(ip, interface)
        if order is not None:
            ranked.append((order, ip, interface))
    ranked.sort(key=lambda item: (item[0], item[1]))
    return [{"ip": ip, "interface": interface} for _, ip, interface in ranked]
