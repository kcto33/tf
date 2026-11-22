// 页面在后台时用系统通知提醒新消息/传输事件。
// 权限在用户点击“进入房间”这类手势时机申请；只弹给隐藏状态的页面，避免打扰。
export function requestNotificationPermission() {
  try {
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission()
    }
  } catch {
    // 不支持通知的环境静默跳过
  }
}

export function notifyIfHidden(title, body) {
  try {
    if (!document.hidden) {
      return
    }
    if (!("Notification" in window) || Notification.permission !== "granted") {
      return
    }
    const notification = new Notification(String(title || "文件传输"), {
      body: String(body || "").slice(0, 120),
      tag: "web-transfer",
    })
    notification.onclick = () => {
      try {
        window.focus()
        notification.close()
      } catch {
        // 部分环境禁止脚本聚焦窗口，忽略
      }
    }
  } catch {
    // 通知失败不影响主流程
  }
}
