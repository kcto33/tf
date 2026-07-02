import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"
import { chromium } from "playwright"

const ROOT = resolve(import.meta.dirname, "..")
const LONG_TOKEN = "超长设备名".repeat(18) + "LONGUNBROKENIDENTIFIER".repeat(8)
const BROWSER_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
]

async function launchBrowser() {
  const executablePath = BROWSER_CANDIDATES.find((candidate) => existsSync(candidate))
  return chromium.launch(executablePath ? { executablePath } : {})
}

async function loadCss(fileName) {
  return readFile(resolve(ROOT, "static", fileName), "utf8")
}

function desktopFixture(css) {
  return `<!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>${css}</style>
      </head>
      <body>
        <main class="page">
          <section class="panel hero">
            <div>
              <p class="eyebrow">${LONG_TOKEN}</p>
              <h1>文件传输</h1>
              <p class="lede">${LONG_TOKEN}</p>
            </div>
            <div class="connection-grid">
              <label><span>显示名</span><input type="text" value="${LONG_TOKEN}" /></label>
              <div class="button-row">
                <button type="button">${LONG_TOKEN}</button>
                <button type="button" class="ghost">${LONG_TOKEN}</button>
              </div>
              <a class="view-switch" href="#">${LONG_TOKEN}</a>
            </div>
          </section>
          <section class="grid">
            <article class="panel">
              <div class="section-head">
                <h2>${LONG_TOKEN}</h2>
                <span class="badge muted">${LONG_TOKEN}</span>
              </div>
              <dl class="status-list">
                <div><dt>当前客户端</dt><dd>${LONG_TOKEN}</dd></div>
                <div><dt>当前目标</dt><dd>${LONG_TOKEN}</dd></div>
              </dl>
              <div class="peer-list">
                <div class="peer-card selected send-selected">
                  <button class="peer-card-button" type="button">
                    <div class="peer-card-copy">
                      <strong class="peer-name">${LONG_TOKEN}</strong>
                      <p class="peer-meta">${LONG_TOKEN}</p>
                    </div>
                    <span class="peer-badge badge muted">${LONG_TOKEN}</span>
                  </button>
                  <button class="peer-send-toggle ghost small" type="button">${LONG_TOKEN}</button>
                </div>
              </div>
              <div class="stack">
                <div class="pending-card">
                  <div>
                    <strong class="pending-title">${LONG_TOKEN}</strong>
                    <p class="pending-meta">${LONG_TOKEN}</p>
                  </div>
                  <div class="button-row compact">
                    <button type="button">${LONG_TOKEN}</button>
                    <button class="ghost" type="button">${LONG_TOKEN}</button>
                  </div>
                </div>
              </div>
            </article>
            <article class="panel">
              <p class="selected-peer-line">发送对象：<strong>${LONG_TOKEN}</strong></p>
              <div class="selection-list">
                <div class="selection-item">
                  <div class="selection-item-header">
                    <strong>${LONG_TOKEN}</strong>
                    <button type="button" class="ghost small selection-remove">${LONG_TOKEN}</button>
                  </div>
                  <p class="selection-meta">${LONG_TOKEN}</p>
                </div>
              </div>
              <div class="history-list">
                <div class="history-item outgoing">
                  <div class="history-title-row">
                    <strong class="history-title">${LONG_TOKEN}</strong>
                    <span class="badge warn">${LONG_TOKEN}</span>
                  </div>
                  <p class="history-files">${LONG_TOKEN}</p>
                  <p class="history-meta">${LONG_TOKEN}</p>
                </div>
              </div>
            </article>
          </section>
          <section class="chat-grid">
            <article class="panel">
              <div class="chat-list">
                <div class="chat-item outgoing">
                  <div class="chat-item-header">
                    <strong>${LONG_TOKEN}</strong>
                    <span class="chat-time">${LONG_TOKEN}</span>
                  </div>
                  <p>${LONG_TOKEN}</p>
                </div>
              </div>
              <div class="log">
                <div class="log-item progress">
                  <strong>${LONG_TOKEN}</strong>
                  <div class="progress-bar"><span style="width: 80%"></span></div>
                  <p>${LONG_TOKEN}</p>
                </div>
                <div class="log-item">
                  <div class="section-head">
                    <strong>${LONG_TOKEN}</strong>
                    <span class="badge danger">${LONG_TOKEN}</span>
                  </div>
                  <p>${LONG_TOKEN}</p>
                </div>
              </div>
            </article>
          </section>
        </main>
      </body>
    </html>`
}

function mobileFixture(css) {
  return `<!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <style>${css}</style>
      </head>
      <body>
        <main class="mobile-page">
          <section class="mobile-card hero-card">
            <p class="eyebrow">${LONG_TOKEN}</p>
            <div class="hero-head">
              <div><h1>文件传输</h1><p class="lede">${LONG_TOKEN}</p></div>
              <a class="switch-link" href="#">${LONG_TOKEN}</a>
            </div>
            <div class="button-row">
              <button type="button">${LONG_TOKEN}</button>
              <button type="button" class="ghost">${LONG_TOKEN}</button>
            </div>
            <div class="status-strip">
              <span class="badge muted">${LONG_TOKEN}</span>
              <span class="badge muted">${LONG_TOKEN}</span>
            </div>
          </section>
          <section class="mobile-card">
            <div class="section-head">
              <h2>${LONG_TOKEN}</h2>
              <span class="subtle">当前目标：<strong>${LONG_TOKEN}</strong></span>
            </div>
            <div class="peer-list">
              <div class="peer-card selected send-selected">
                <button class="peer-card-button" type="button">
                  <div class="peer-card-copy">
                    <strong class="peer-name">${LONG_TOKEN}</strong>
                    <p class="peer-meta">${LONG_TOKEN}</p>
                  </div>
                  <span class="peer-badge badge muted">${LONG_TOKEN}</span>
                </button>
                <button class="peer-send-toggle ghost small" type="button">${LONG_TOKEN}</button>
              </div>
            </div>
            <div class="pending-list">
              <div class="pending-card">
                <div>
                  <strong class="pending-title">${LONG_TOKEN}</strong>
                  <p class="pending-meta">${LONG_TOKEN}</p>
                </div>
                <div class="button-row compact">
                  <button type="button">${LONG_TOKEN}</button>
                  <button type="button" class="ghost">${LONG_TOKEN}</button>
                </div>
              </div>
            </div>
          </section>
          <section class="mobile-card">
            <div class="selection-list">
              <div class="selection-item">
                <div class="selection-item-header">
                  <strong>${LONG_TOKEN}</strong>
                  <button type="button" class="ghost small selection-remove">${LONG_TOKEN}</button>
                </div>
                <p>${LONG_TOKEN}</p>
              </div>
            </div>
            <div class="chat-list">
              <div class="chat-item outgoing">
                <strong>${LONG_TOKEN}</strong>
                <p>${LONG_TOKEN}</p>
                <p>${LONG_TOKEN}</p>
              </div>
            </div>
            <div class="status-list">
              <div class="status-item">
                <strong>${LONG_TOKEN}</strong>
                <p>${LONG_TOKEN}</p>
              </div>
            </div>
          </section>
        </main>
      </body>
    </html>`
}

async function findOverflowingElements(page) {
  return page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth
    const pageOverflow = document.documentElement.scrollWidth - viewportWidth
    const elements = Array.from(document.body.querySelectorAll("*"))
    const offenders = elements
      .filter((element) => {
        if (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) {
          return false
        }
        const rect = element.getBoundingClientRect()
        if (rect.width < 1 || rect.height < 1) {
          return false
        }
        return element.scrollWidth > element.clientWidth + 1 || rect.right > viewportWidth + 1
      })
      .slice(0, 20)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        className: element.className || "",
        text: (element.textContent || "").trim().slice(0, 80),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        right: Math.round(element.getBoundingClientRect().right),
      }))
    return { pageOverflow, offenders }
  })
}

async function assertNoHorizontalOverflow(browser, name, html, viewport) {
  const page = await browser.newPage({ viewport })
  try {
    await page.setContent(html)
    const result = await findOverflowingElements(page)
    assert.equal(result.pageOverflow, 0, `${name} page has horizontal overflow: ${JSON.stringify(result)}`)
    assert.deepEqual(result.offenders, [], `${name} has overflowing elements: ${JSON.stringify(result)}`)
  } finally {
    await page.close()
  }
}

test("layout keeps long desktop content inside cards", async () => {
  const browser = await launchBrowser()
  try {
    const css = await loadCss("styles.css")
    await assertNoHorizontalOverflow(browser, "desktop wide", desktopFixture(css), { width: 1280, height: 900 })
    await assertNoHorizontalOverflow(browser, "desktop narrow", desktopFixture(css), { width: 390, height: 900 })
  } finally {
    await browser.close()
  }
})

test("layout keeps long mobile content inside cards", async () => {
  const browser = await launchBrowser()
  try {
    const css = await loadCss("mobile.css")
    await assertNoHorizontalOverflow(browser, "mobile", mobileFixture(css), { width: 390, height: 900 })
  } finally {
    await browser.close()
  }
})
