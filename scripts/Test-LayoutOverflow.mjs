import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"
import { chromium } from "playwright"

// 端到端布局测试：启动真实服务端，两个浏览器页面进入同一房间，
// 塞入超长设备名/文件名/聊天文本后断言任意视口都没有横向溢出或元素出界。
const ROOT = resolve(import.meta.dirname, "..")
const PORT = 8123
const BASE_URL = `http://127.0.0.1:${PORT}`
const LONG_NAME = "超长设备名".repeat(9) + "LONGUNBROKENIDENTIFIER"
const LONG_CHAT = "这是一条非常非常长的消息。".repeat(20) + "NOWHITESPACE" + "x".repeat(120)

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
      // 服务未就绪，继续等待
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

async function joinRoom(page, displayName, roomCode) {
  // 页面加载后会用 URL 参数自动进入房间（与人工输入同一条路径）。
  const url = `${BASE_URL}/?room=${encodeURIComponent(roomCode)}&name=${encodeURIComponent(displayName)}`
  await page.goto(url, { waitUntil: "domcontentloaded" })
  await page.waitForFunction(() => {
    const badge = document.querySelector("#connectionBadge")
    return badge && badge.textContent.includes("已连接")
  })
}

async function findOverflowingElements(page) {
  return page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth
    const pageOverflow = document.documentElement.scrollWidth - viewportWidth
    const offenders = Array.from(document.body.querySelectorAll("*"))
      .filter((element) => {
        if (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) {
          return false
        }
        const rect = element.getBoundingClientRect()
        if (rect.width < 1 || rect.height < 1) {
          return false
        }
        // 元素本身逃出视口：直接违规
        if (rect.right > viewportWidth + 1 || rect.left < -1) {
          return true
        }
        const style = getComputedStyle(element)
        // ellipsis / 滚动容器是合法的内容截断手段（scrollWidth > clientWidth 是预期行为），
        // 只有完全没有截断机制还内容超宽才算重叠/挤压。
        const clamped =
          ["hidden", "auto", "scroll", "clip"].includes(style.overflowX) ||
          style.textOverflow === "ellipsis"
        return !clamped && element.scrollWidth > element.clientWidth + 1
      })
      .slice(0, 12)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        className: String(element.className || "").slice(0, 60),
        text: (element.textContent || "").trim().slice(0, 60),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        right: Math.round(element.getBoundingClientRect().right),
      }))
    return { pageOverflow, offenders }
  })
}

async function assertNoHorizontalOverflow(page, label) {
  const result = await findOverflowingElements(page)
  assert.equal(result.pageOverflow, 0, `${label}: page has horizontal overflow ${JSON.stringify(result)}`)
  assert.deepEqual(result.offenders, [], `${label}: overflowing elements ${JSON.stringify(result)}`)
}

test("layout keeps long content inside cards at every viewport", async () => {
  const server = await startServer()
  const browser = await launchBrowser()
  try {
    const room = `LAYOUT-${Date.now()}`
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 768, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const pageA = await browser.newPage({ viewport })
      const pageB = await browser.newPage({ viewport })
      try {
        await joinRoom(pageA, LONG_NAME, room)
        await joinRoom(pageB, `${LONG_NAME}-2`, room)

        // 双方互见：设备卡渲染超长名字
        await pageA.waitForSelector(".peer-card")
        await pageB.waitForSelector(".peer-card")

        // 选择文件 + 超长聊天，让选择列表/聊天气泡都进入最坏情况
        await pageA.evaluate((text) => {
          const input = document.querySelector("#chatInput")
          input.value = text
          input.dispatchEvent(new Event("input", { bubbles: true }))
        }, LONG_CHAT)
        await pageA.click("#chatSendBtn")
        await pageB.waitForSelector(".chat-item")

        // 注入一个超长的待确认传输卡与选中文件（不真正传输，只测布局）
        await pageB.evaluate((name) => {
          const selection = document.querySelector("#selectionList")
          selection.className = "list selection-list"
          selection.innerHTML = `
            <div class="selection-item">
              <span class="item-icon">F</span>
              <div class="selection-copy">
                <strong class="ellipsis">${name}</strong>
                <span class="selection-meta">1.2 MB</span>
              </div>
              <button type="button" class="icon-btn">×
              </button>
            </div>`
        }, `${LONG_NAME}.pdf`)

        await pageA.waitForTimeout(300)
        await assertNoHorizontalOverflow(pageA, `page A @${viewport.width}`)
        await assertNoHorizontalOverflow(pageB, `page B @${viewport.width}`)
      } finally {
        await pageA.close()
        await pageB.close()
      }
    }
  } finally {
    await browser.close()
    server.child.kill()
  }
})
