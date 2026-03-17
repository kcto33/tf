from __future__ import annotations

import ctypes
import os
import socket
import subprocess
import sys
import threading
import time
import traceback
import webbrowser
import winreg
from contextlib import closing, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any


APP_NAME = "FileTransfer"
APP_TITLE = "文件传输"
DEFAULT_PORT = int(os.getenv("WEB_TRANSFER_PORT", "8000"))
STARTUP_VALUE_NAME = "FileTransferTray"
STARTUP_ARGUMENT = "--startup"
MUTEX_NAME = "Global\\FileTransferTraySingleton"
LOG_DIR = Path(os.getenv("LOCALAPPDATA", str(Path.home()))) / "FileTransfer"
LOG_FILE = LOG_DIR / "launcher.log"


@dataclass
class RuntimeState:
    port: int
    local_url: str
    lan_url: str
    server_process: subprocess.Popen[str] | None = None
    icon: Any = None
    should_open_browser: bool = False


STATE = RuntimeState(
    port=DEFAULT_PORT,
    local_url=f"http://127.0.0.1:{DEFAULT_PORT}",
    lan_url=f"http://127.0.0.1:{DEFAULT_PORT}",
    should_open_browser=STARTUP_ARGUMENT not in sys.argv[1:],
)


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def get_runtime_dir() -> Path:
    if is_frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def get_bundle_dir() -> Path:
    bundle_dir = getattr(sys, "_MEIPASS", None)
    if bundle_dir:
        return Path(bundle_dir)
    return get_runtime_dir()


def get_executable_command() -> str | None:
    if is_frozen():
        return f'"{Path(sys.executable)}" {STARTUP_ARGUMENT}'
    return None


def log_message(message: str) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a", encoding="utf-8") as handle:
            handle.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}\n")
    except Exception:
        pass


def create_single_instance_mutex() -> tuple[int, bool]:
    handle = ctypes.windll.kernel32.CreateMutexW(None, False, MUTEX_NAME)
    already_exists = ctypes.GetLastError() == 183
    return handle, already_exists


def release_mutex(handle: int) -> None:
    if handle:
        ctypes.windll.kernel32.ReleaseMutex(handle)
        ctypes.windll.kernel32.CloseHandle(handle)


def get_local_ip() -> str:
    with closing(socket.socket(socket.AF_INET, socket.SOCK_DGRAM)) as sock:
        try:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
        except OSError:
            return "127.0.0.1"


def port_is_free(port: int) -> bool:
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        return sock.connect_ex(("127.0.0.1", port)) != 0


def wait_for_server(port: int, timeout_seconds: float = 12.0) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                return True
        if STATE.server_process and STATE.server_process.poll() is not None:
            return False
        time.sleep(0.25)
    return False


def ensure_startup_registration() -> None:
    command = get_executable_command()
    if not command:
        return
    with winreg.OpenKey(
        winreg.HKEY_CURRENT_USER,
        r"Software\Microsoft\Windows\CurrentVersion\Run",
        0,
        winreg.KEY_SET_VALUE,
    ) as key:
        winreg.SetValueEx(key, STARTUP_VALUE_NAME, 0, winreg.REG_SZ, command)
    log_message(f"Startup registration ensured: {command}")


def remove_startup_registration() -> None:
    with suppress(FileNotFoundError):
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            0,
            winreg.KEY_SET_VALUE,
        ) as key:
            winreg.DeleteValue(key, STARTUP_VALUE_NAME)


def is_startup_registered() -> bool:
    with suppress(FileNotFoundError):
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
        ) as key:
            value, _ = winreg.QueryValueEx(key, STARTUP_VALUE_NAME)
            return bool(value)
    return False


def notify(icon: Any, message: str) -> None:
    with suppress(Exception):
        icon.notify(message, APP_TITLE)


def show_error_dialog(message: str) -> None:
    with suppress(Exception):
        ctypes.windll.user32.MessageBoxW(None, message, APP_TITLE, 0x10)


def open_local_page(icon: Any | None = None, item: Any | None = None) -> None:
    webbrowser.open(STATE.local_url)


def open_lan_page(icon: Any | None = None, item: Any | None = None) -> None:
    webbrowser.open(STATE.lan_url)


def toggle_startup(icon: Any, item: Any) -> None:
    if is_startup_registered():
        remove_startup_registration()
        notify(icon, "已关闭开机自启")
    else:
        ensure_startup_registration()
        notify(icon, "已开启开机自启")
    icon.update_menu()


def quit_app(icon: Any | None = None, item: Any | None = None) -> None:
    stop_server_process()
    if STATE.icon:
        STATE.icon.stop()


def create_icon_image() -> Any:
    from PIL import Image, ImageDraw

    image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((6, 6, 58, 58), radius=16, fill=(203, 93, 47, 255))
    draw.rounded_rectangle((14, 14, 50, 50), radius=12, fill=(255, 246, 236, 255))
    draw.rectangle((20, 24, 44, 28), fill=(148, 58, 21, 255))
    draw.rectangle((20, 34, 36, 38), fill=(29, 122, 97, 255))
    draw.polygon([(42, 38), (48, 44), (42, 50)], fill=(29, 122, 97, 255))
    return image


def build_menu() -> Any:
    from pystray import Menu, MenuItem

    return Menu(
        MenuItem("打开本机页面", open_local_page, default=True),
        MenuItem("打开局域网页面", open_lan_page),
        Menu.SEPARATOR,
        MenuItem("开机自启", toggle_startup, checked=lambda item: is_startup_registered()),
        MenuItem("退出", quit_app),
    )


def build_server_command(port: int) -> list[str]:
    if is_frozen():
        external_server = get_runtime_dir() / "FileTransferServer.exe"
        bundled_server = get_bundle_dir() / "FileTransferServer.exe"
        if external_server.exists():
            server_exe = external_server
        elif bundled_server.exists():
            server_exe = bundled_server
        else:
            raise FileNotFoundError(
                "Bundled server executable is missing. Re-extract the package and keep FileTransfer.exe intact."
            )
        return [str(server_exe), "--port", str(port)]
    return [sys.executable, str(get_runtime_dir() / "server_entry.py"), "--port", str(port)]


def start_server() -> None:
    STATE.port = DEFAULT_PORT
    STATE.local_url = f"http://127.0.0.1:{STATE.port}"
    STATE.lan_url = f"http://{get_local_ip()}:{STATE.port}"
    command = build_server_command(STATE.port)
    log_message(f"Starting server process: {' '.join(command)}")
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    STATE.server_process = subprocess.Popen(
        command,
        cwd=str(get_runtime_dir()),
        creationflags=creationflags,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if not wait_for_server(STATE.port):
        code = None
        if STATE.server_process:
            code = STATE.server_process.poll()
        raise RuntimeError(f"File transfer service failed to start. exit_code={code}")
    log_message(f"Server ready at {STATE.local_url} / {STATE.lan_url}")


def stop_server_process() -> None:
    if not STATE.server_process:
        return
    pid = STATE.server_process.pid
    log_message(f"Stopping server process tree: pid={pid}")
    with suppress(Exception):
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    with suppress(Exception):
        STATE.server_process.wait(timeout=5)
    STATE.server_process = None


def run_tray() -> None:
    import pystray

    log_message("Initializing tray icon.")
    icon = pystray.Icon(APP_NAME, create_icon_image(), APP_TITLE, menu=build_menu())
    STATE.icon = icon
    notify(icon, f"服务已运行：{STATE.lan_url}")
    if STATE.should_open_browser:
        threading.Timer(1.0, open_local_page).start()
    try:
        icon.run()
    except Exception:
        log_message(f"Tray crashed:\n{traceback.format_exc()}")
        raise


def main() -> None:
    mutex_handle, already_exists = create_single_instance_mutex()
    log_message("Launcher starting.")
    if already_exists:
        log_message("Existing instance detected; opening browser only.")
        webbrowser.open(f"http://127.0.0.1:{DEFAULT_PORT}")
        release_mutex(mutex_handle)
        return

    try:
        if not port_is_free(DEFAULT_PORT):
            log_message(f"Port {DEFAULT_PORT} already occupied; opening browser only.")
            webbrowser.open(f"http://127.0.0.1:{DEFAULT_PORT}")
            return

        ensure_startup_registration()
        start_server()
        run_tray()
    except Exception:
        log_message(f"Launcher failed:\n{traceback.format_exc()}")
        if is_frozen():
            show_error_dialog("启动失败，请重新解压完整分发包后再试。详细信息已写入日志。")
            return
        raise
    finally:
        stop_server_process()
        release_mutex(mutex_handle)
        log_message("Launcher exiting.")


if __name__ == "__main__":
    main()
