# 文件传输

一个局域网网页文件传输项目，使用 `FastAPI + WebSocket + WebRTC DataChannel`。

桌面、手机共用同一份单页响应式前端（自动适配窄屏，手机浏览器保留单文件收发的安全限制），服务端只做信令，文件内容始终通过浏览器点对点传输。

## 功能

- 多台设备打开同一个网页，输入同一个房间码后进入同一房间
- 房间内可选择任意在线设备作为发送目标，支持多设备批量发送
- 支持选择文件、选择文件夹、拖拽文件或文件夹发送
- 接收端每次都需要确认
- 文件内容通过浏览器点对点传输，服务端只负责信令；直连不可用时自动降级为中继
- 使用 IndexedDB 保存历史记录和未完成接收块，支持接收端刷新后恢复
- 单文件直接下载，多文件或文件夹自动打包为 ZIP 下载
- 设备间可互发聊天消息，未读消息有红点提示，消息支持一键复制（兼容局域网 http 非安全上下文）
- 聊天支持发送图片和文件附件（单个 ≤16MB）：图片气泡内嵌预览、点击放大，文件点击即可下载；支持直接粘贴截图和整页拖拽
- 长文本消息气泡自动折叠（超过 500 字符或 14 行），可一键展开/收起
- “邀请设备”弹出二维码，手机扫码即带房间码加入
- 发送端断点续传：发送页中途刷新后，出现“选择文件继续”卡片，按路径+大小匹配并做 SHA-256 校验，复用原会话 ID 续传
- 传输进行中关闭页面/离开房间会先确认，防止误杀
- 页面切到后台时用系统通知提醒新消息、传输请求和接收完成；标签页标题实时显示传输百分比
- 深浅色模式跟随系统

## 目录结构

```
app/                 FastAPI 服务端
  config.py          路径/常量配置
  hub.py             房间登记表（RoomHub）
  routes.py          页面与健康检查路由
  signaling.py       WebSocket 信令端点
  main.py            应用装配
static/
  index.html         单页入口（桌面/手机共用）
  app.css            设计系统（深浅色自适应）
  js/
    constants.js     传输协议常量
    core/            传输引擎（signaling / peer-connection / sender / receiver / chat）
    storage/         IndexedDB 会话存储
    protocol/        消息助手与错误类型
    utils/           crypto / zip / qr / clipboard / notify 等纯函数
    vendor/          qrcode-generator（MIT，二维码生成）
    ui/              唯一渲染层 + 入口
scripts/             构建、测试脚本
tests/               后端 pytest 测试
```

前端为原生 ES Modules，无构建步骤；`scripts/Build-*.ps1` 打包时整体捆绑 `static/` 目录。

## 开发运行

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

浏览器打开 [http://127.0.0.1:8000](http://127.0.0.1:8000)。

如果要让另一台局域网设备访问，把 `127.0.0.1` 替换成当前机器的局域网 IP，例如 `http://192.168.1.20:8000`。

## 测试

```powershell
# 后端：信令房间逻辑 + WebSocket 集成测试（需要 venv 和 requirements-dev.txt）
.venv\Scripts\python.exe -m pytest tests/ -q
.venv\Scripts\python.exe -m ruff check app tests launcher.py server_entry.py

# 前端：传输取消/续传守卫逻辑（Node 内置测试器）
npm run test:core

# 前端：布局溢出端到端测试（Playwright，需本机 Chrome/Edge，会临时启动 uvicorn）
npm run test:layout

# 前端：端到端真实传输冒烟（双页面 WebRTC 直连 + 确认接收 + 下载内容比对）
npm run test:e2e
```

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
- 安装器会自动添加防火墙放行规则（管理员安装时立即生效；非管理员安装首次启动时请在 Windows 弹窗中点“允许”）
- 开发运行如需局域网访问，首次运行 `scripts\Enable-Firewall-8001.bat`（自动请求管理员权限）放行开发端口
- 首次运行如果 Windows 弹出防火墙提示，需要允许访问

## GitHub Actions

- **CI**（push / PR）：ruff + pytest + Node 传输逻辑测试 + Playwright 布局溢出测试
- **Release**（推送 `v<major>.<minor>.<patch>` tag）：Windows runner 上构建并发布
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
- 手机浏览器（移动 UA）仅支持单文件收发，多文件请在电脑端接收
- 聊天消息（含附件）只保存在内存中，页面刷新后不保留；大文件请走“发送文件”流程（带断点续传）
- 当前不包含公网 TURN 中继，也不包含账号系统
