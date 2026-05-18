# 文件传输

一个局域网网页文件传输项目，使用 `FastAPI + WebSocket + WebRTC DataChannel`。

## 功能

- 多台 PC 打开同一个网页，输入同一个房间码后进入同一房间
- 房间内可选择任意在线设备作为发送目标
- 支持选择文件、选择文件夹、拖拽文件或文件夹发送
- 接收端每次都需要确认
- 文件内容通过浏览器点对点传输，服务端只负责信令
- 使用 IndexedDB 保存历史记录和未完成接收块，支持接收端刷新后恢复
- 单文件直接下载，多文件或文件夹自动打包为 ZIP 下载
- 历史记录区分发送和接收背景色，展示文件名、传输对象和完成时间

## 开发运行

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

浏览器打开 [http://127.0.0.1:8000](http://127.0.0.1:8000)。

如果要让另一台局域网电脑访问，把 `127.0.0.1` 替换成当前机器的局域网 IP，例如 `http://192.168.1.20:8000`。

## Windows 打包

构建 Windows 分发包：

```powershell
.\build_windows.ps1
```

产物：

- `dist\FileTransfer\`
- `dist\FileTransfer\FileTransfer.exe`
- `dist\FileTransfer\FileTransferServer.exe`
- `dist\FileTransfer-win.zip`

运行方式：

- 双击 `FileTransfer.exe`
- `FileTransfer.exe` 已内嵌服务端，单独拷贝这个文件也可以运行
- 程序默认注册当前用户开机自启
- 前台不会显示控制台窗口
- 程序只在系统托盘常驻
- 托盘菜单可打开本机页面、局域网页面、切换开机自启、退出程序

注意：

- 完整分发包里仍会附带 `FileTransferServer.exe`，主要用于诊断和独立测试
- 首次运行如果 Windows 弹出防火墙提示，需要允许访问

## GitHub Release 自动打包

推送 `v<major>.<minor>.<patch>` 格式的 tag 后，GitHub Actions 会在 Windows runner 上构建：

- `FileTransfer-win-x64-onefile-*.zip`
- `FileTransfer-<version>-setup.exe`

本地也可以使用同一套脚本：

```powershell
.\scripts\Build-Package.ps1 -Version "1.0.0" -VersionSuffix "local"
.\scripts\Build-Installer.ps1 -Version "1.0.0"
```

安装器会同时安装 `FileTransfer.exe` 和 `FileTransferServer.exe`。

## 当前边界

- 主要面向 Chromium 系浏览器
- 断点恢复重点覆盖“接收端刷新后恢复”；发送端刷新后不会保留待发送文件句柄
- 当前不包含公网 TURN 中继，也不包含账号系统
