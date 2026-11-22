@echo off
chcp 65001 >nul
REM 局域网文件传输 - 防火墙放行 8001 端口（自动请求管理员权限）

net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

netsh advfirewall firewall delete rule name="WebTransfer-8001-TCP" >nul 2>&1
netsh advfirewall firewall delete rule name="WebTransfer-8001-UDP" >nul 2>&1
netsh advfirewall firewall add rule name="WebTransfer-8001-TCP" dir=in action=allow protocol=TCP localport=8001
netsh advfirewall firewall add rule name="WebTransfer-8001-UDP" dir=in action=allow protocol=UDP localport=8001

if %errorlevel% equ 0 (
    echo.
    echo [OK] 防火墙规则已添加：TCP/UDP 8001 已放行。
) else (
    echo.
    echo [!] 添加失败。
)
echo.
echo 本窗口可以关闭。
pause
