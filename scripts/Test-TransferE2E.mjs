import assert from "node:assert/strict"
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import { chromium } from "playwright"
import jsQR from "jsqr"

// 端到端冒烟测试：两个真实页面进入同一房间，完成一次
// WebRTC 直连文件传输（含接收确认），并检查双端聊天与响应式截图。
// 用法: node scripts/Test-TransferE2E.mjs [--keep-screenshots]
const ROOT = resolve(import.meta.dirname, "..")
const PORT = 8124
const BASE_URL = `http://127.0.0.1:${PORT}`
const SHOT_DIR = process.env.E2E_SHOT_DIR || mkdtempSync(join(tmpdir(), "tf-e2e-"))

const BROWSER_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
]

async function startServer() {
  const { spawn } = await import("node:child_process")
  const python = process.env.PYTHON || "python"
  const child = spawn(python, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(PORT)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  child.stderr.on("data", (chunk) => {
    output += String(chunk)
  })
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/health`)
      if (response.ok) {
        return { child, output: () => output }
      }
    } catch {
      // 服务未就绪
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250))
  }
  child.kill()
  throw new Error(`uvicorn failed to start: ${output}`)
}

function launchBrowser() {
  const executablePath = BROWSER_CANDIDATES.find((candidate) => existsSync(candidate))
  return chromium.launch(executablePath ? { executablePath } : {})
}

async function joinRoom(context, displayName, roomCode) {
  const page = await context.newPage()
  const url = `${BASE_URL}/?room=${encodeURIComponent(roomCode)}&name=${encodeURIComponent(displayName)}`
  await page.goto(url, { waitUntil: "domcontentloaded" })
  await page.waitForFunction(() => {
    const badge = document.querySelector("#connectionBadge")
    return badge && badge.textContent.includes("已连接")
  })
  return page
}

test("end-to-end file transfer and chat between two real pages", async () => {
  const server = await startServer()
  const browser = await launchBrowser()
  const artifacts = []
  try {
    const context = await browser.newContext({ acceptDownloads: true })
    await context.grantPermissions(["clipboard-read", "clipboard-write", "notifications"], { origin: BASE_URL })
    const room = `E2E-${Date.now()}`

    const pageA = await joinRoom(context, "发送端甲", room)
    const pageB = await joinRoom(context, "接收端乙", room)

    await pageA.waitForSelector(".peer-card")
    await pageB.waitForSelector(".peer-card")

    // 等待 DataChannel 真正打通（设备卡出现“直连”状态）
    await pageA.waitForFunction(() => document.querySelector(".peer-card .state-ok") !== null, null, {
      timeout: 20000,
    })

    // 扫码进房：邀请弹窗二维码内容可被解码且携带房间码
    await pageA.click("#inviteBtn")
    await pageA.waitForSelector("#inviteModal:not([hidden])")
    await pageA.waitForFunction(() => document.querySelector("#inviteQr")?.width > 100)
    const qrUrlText = await pageA.textContent("#inviteUrl")
    assert.ok(qrUrlText.includes(`room=${room}`), `invite url missing room: ${qrUrlText}`)
    const qrPixels = await pageA.evaluate(() => {
      const canvas = document.querySelector("#inviteQr")
      const { width, height } = canvas
      const data = canvas.getContext("2d").getImageData(0, 0, width, height).data
      return { width, height, data: Array.from(data) }
    })
    const decoded = jsQR(new Uint8ClampedArray(qrPixels.data), qrPixels.width, qrPixels.height)
    assert.ok(decoded, "QR code should be decodable")
    assert.ok(decoded.data.includes(`room=${room}`), `decoded QR missing room: ${decoded.data}`)
    await pageA.click("#inviteClose")
    await pageA.waitForSelector("#inviteModal[hidden]", { state: "attached" })

    // 整页拖拽：合成 drop 事件到聊天卡片 → 进入聊天待发附件
    await pageA.evaluate(() => {
      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(new File(["dropped via drag"], "dropped.txt", { type: "text/plain" }))
      document.querySelector("#chatCard").dispatchEvent(
        new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true })
      )
    })
    await pageA.waitForSelector(".chat-pending-chip")
    assert.equal(
      await pageA.locator(".chat-pending-chip").count(),
      1,
      "drop on chat card should add one pending chat attachment"
    )
    await pageA.click("[data-action='remove-pending']")

    // 双向聊天（DataChannel 打通后走直连）
    await pageA.fill("#chatInput", "你好，接收端乙！")
    await pageA.click("#chatSendBtn")
    await pageB.waitForSelector(".chat-item.incoming")
    await pageB.fill("#chatInput", "收到，请发文件。")
    await pageB.click("#chatSendBtn")
    await pageA.waitForSelector(".chat-item.incoming")

    // 消息一键复制：在 B 端复制收到的消息，回读剪贴板比对
    await pageB.click(".chat-item.incoming .chat-copy")
    await pageB.waitForFunction(() => document.querySelector(".chat-item.incoming .chat-copy")?.classList.contains("copied"))
    const clipboardText = await pageB.evaluate(() => navigator.clipboard.readText())
    assert.equal(clipboardText, "你好，接收端乙！", "clipboard content mismatch")

    // 长文本自动折叠：>500 字符的消息出现“展开全部”，点击后完整显示
    const longText = "这是一段用来验证折叠的超长消息。".repeat(40)
    await pageA.fill("#chatInput", longText)
    await pageA.click("#chatSendBtn")
    await pageB.waitForSelector(".chat-item.incoming .chat-expand-btn")
    assert.equal(
      await pageB.locator(".chat-item.incoming .chat-text.collapsed").count(),
      1,
      "long message should start collapsed"
    )
    await pageB.click(".chat-item.incoming .chat-expand-btn")
    await pageB.waitForFunction(() => !document.querySelector(".chat-item.incoming .chat-text.collapsed"))

    // 图片发送：A 选择图片 → B 收到内嵌图片气泡
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64"
    )
    await pageA.setInputFiles("#chatFileInput", [{ name: "screenshot.png", mimeType: "image/png", buffer: pngBytes }])
    await pageA.waitForSelector(".chat-pending-chip")
    await pageA.click("#chatSendBtn")
    await pageB.waitForSelector(".chat-item.incoming .chat-image")
    await pageB.waitForFunction(() => {
      const image = document.querySelector(".chat-item.incoming .chat-image")
      return image && image.naturalWidth > 0
    })

    // 文件发送：A 附带 txt → B 收到下载 chip，内容逐字节一致
    const chatPayload = Buffer.from(`chat attachment payload ${Date.now()}`)
    await pageA.setInputFiles("#chatFileInput", [{ name: "chat-note.txt", mimeType: "text/plain", buffer: chatPayload }])
    await pageA.click("#chatSendBtn")
    await pageB.waitForSelector(".chat-item.incoming .chat-file-chip")
    const chatDownloadPromise = pageB.waitForEvent("download", { timeout: 20000 })
    await pageB.click(".chat-item.incoming .chat-file-chip")
    const chatDownload = await chatDownloadPromise
    const chatDownloadPath = join(SHOT_DIR, "received-" + chatDownload.suggestedFilename())
    await chatDownload.saveAs(chatDownloadPath)
    assert.equal(readFileSync(chatDownloadPath).equals(chatPayload), true, "chat file content mismatch")

    artifacts.push(await pageA.screenshot({ path: join(SHOT_DIR, "desktop-chat.png"), fullPage: true }))

    // 文件传输：A 选择文件 → 发起传输 → B 确认接收 → 浏览器下载
    const payload = Buffer.from(`FileTransfer E2E payload ${Date.now()} ` + "0123456789".repeat(2000))
    const downloadPromise = pageB.waitForEvent("download", { timeout: 30000 })
    await pageA.setInputFiles("#fileInput", [
      { name: "e2e-payload.txt", mimeType: "text/plain", buffer: payload },
    ])
    await pageA.click("#sendBtn")

    const acceptButton = pageB.locator(".pending-card .primary")
    await acceptButton.waitFor({ timeout: 15000 })
    await acceptButton.click()

    const download = await downloadPromise
    const targetPath = join(SHOT_DIR, download.suggestedFilename())
    await download.saveAs(targetPath)
    const received = readFileSync(targetPath)
    assert.equal(received.length, payload.length, "downloaded size mismatch")
    assert.equal(received.equals(payload), true, "downloaded content mismatch")

    // 发送端状态回到空闲、历史出现完成记录
    await pageA.waitForFunction(
      () => document.querySelector("#transferBadge").textContent.includes("空闲"),
      null,
      { timeout: 15000 }
    )
    await pageA.waitForFunction(() => document.querySelector("#historyList .history-item") !== null)

    // ===== 发送端断点续传：中途刷新发送页 → 恢复卡片 → 重选文件 → 续传完成 =====
    // 96MB 在本机直连下仍可能瞬间传完，先给 DataChannel 每块加 10ms 延迟，
    // 把整个传输拉长到约 4 秒，保证刷新时传输必然未完成。
    await pageA.evaluate(() => {
      const app = window.__transferApp
      const connection = [...app.state.connections.values()].find(
        (candidate) => candidate.channel && candidate.channel.readyState === "open"
      )
      const channel = connection.channel
      const originalSend = channel.send.bind(channel)
      let delayMs = 0
      channel.send = (data) => {
        delayMs += 10
        setTimeout(() => originalSend(data), delayMs)
      }
    })
    const bigPayload = Buffer.alloc(96 * 1024 * 1024)
    for (let offset = 0; offset < bigPayload.length; offset += 4096) {
      bigPayload[offset] = (offset * 31) % 251
    }
    const bigName = "resume-payload.bin"
    const bigFilePath = join(SHOT_DIR, bigName)
    writeFileSync(bigFilePath, bigPayload)
    await pageA.setInputFiles("#fileInput", [bigFilePath])
    await pageA.click("#sendBtn")
    const bigAccept = pageB.locator(".pending-card .primary")
    await bigAccept.waitFor({ timeout: 20000 })
    await bigAccept.click()

    // 标签页标题应出现传输百分比
    await pageA.waitForFunction(() => /\d+% · 文件传输/.test(document.title), null, { timeout: 20000 })

    // 中途刷新发送端（传输进行中 → beforeunload 确认对话框）
    pageA.on("dialog", (dialog) => dialog.accept())
    await pageA.reload({ waitUntil: "domcontentloaded" })
    await pageA.waitForFunction(
      () => document.querySelector("#connectionBadge")?.textContent.includes("已连接"),
      null,
      { timeout: 20000 }
    )

    // 恢复卡片出现 → 选择相同文件 → 校验后以同一 sessionId 重发请求
    await pageA.waitForSelector("[data-action='select-resume-files']", { timeout: 20000 })
    const [chooser] = await Promise.all([
      pageA.waitForEvent("filechooser"),
      pageA.click("[data-action='select-resume-files']"),
    ])
    await chooser.setFiles([bigFilePath])

    // B 端确认续传（卡片带“可续传”标记），已收分块跳过，最终下载内容逐字节一致
    const resumeAccept = pageB.locator(".pending-card .primary")
    await resumeAccept.waitFor({ timeout: 30000 })
    const resumeMeta = await pageB.textContent(".pending-card .pending-meta")
    assert.ok(resumeMeta.includes("可续传"), `resume card should be marked resumable: ${resumeMeta}`)
    const bigDownloadPromise = pageB.waitForEvent("download", { timeout: 180000 })
    await resumeAccept.click()
    const bigDownload = await bigDownloadPromise
    const bigPath = join(SHOT_DIR, "resumed-" + bigDownload.suggestedFilename())
    await bigDownload.saveAs(bigPath)
    const resumed = readFileSync(bigPath)
    assert.equal(resumed.length, bigPayload.length, "resumed file size mismatch")
    assert.equal(resumed.equals(bigPayload), true, "resumed file content mismatch")

    // 传输结束后标题恢复
    await pageA.waitForFunction(() => document.title === "文件传输", null, { timeout: 20000 })

    // 手机宽度响应式截图（第三个页面加入同一房间；显式给 iPhone UA 以触发移动端降级）
    const mobileContext = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    })
    const pageC = await joinRoom(mobileContext, "手机端丙", room)
    await pageC.waitForSelector(".peer-card")
    artifacts.push(await pageC.screenshot({ path: join(SHOT_DIR, "mobile.png"), fullPage: true }))

    // 窄屏平板宽度
    const tabletPage = await browser.newPage({ viewport: { width: 768, height: 1024 } })
    await tabletPage.goto(`${BASE_URL}/?room=${encodeURIComponent(room)}&name=${encodeURIComponent("平板端丁")}`, {
      waitUntil: "domcontentloaded",
    })
    await tabletPage.waitForFunction(() => {
      const badge = document.querySelector("#connectionBadge")
      return badge && badge.textContent.includes("已连接")
    })
    artifacts.push(await tabletPage.screenshot({ path: join(SHOT_DIR, "tablet.png"), fullPage: true }))
    await tabletPage.close()
    await mobileContext.close()
    await context.close()

    console.log(`E2E PASS. screenshots/downloads: ${SHOT_DIR}`)
  } finally {
    await browser.close()
    server.child.kill()
  }
})
