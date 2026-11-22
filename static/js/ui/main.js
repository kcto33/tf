import { createTransferApp } from "../index.js"
import { createView } from "./view.js"

// 手机浏览器保持与旧版移动页一致的安全限制：单文件收发；
// 电脑端开放多文件、文件夹、多设备批量发送。历史记录所有端启用。
function isMobileRuntime() {
  const userAgent = navigator.userAgent || ""
  return /iPhone|iPad|Android|Mobile/i.test(userAgent)
}

const isMobile = isMobileRuntime()

const app = createTransferApp({
  allowMultipleFiles: !isMobile,
  allowIncomingMultiFile: !isMobile,
  enableHistory: true,
  enableResume: true,
})

function bootstrap() {
  const view = createView(app)
  view.bind()
  app.subscribe(view.render)
  view.render()
  app.initialize().then(view.render).catch(() => {})
  // 调试/自动化钩子：控制台或 E2E 测试可直接操作应用实例。
  window.__transferApp = app
  // PWA：注册直通型 Service Worker（不缓存，满足安装条件即可）
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/static/sw.js", { scope: "/" }).catch(() => {})
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap)
} else {
  bootstrap()
}
