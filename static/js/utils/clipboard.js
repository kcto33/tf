// 复制文本到剪贴板。
// 局域网通过 http://IP 访问时不是安全上下文，navigator.clipboard 不存在，
// 此时退回 textarea + execCommand 兜底（旧式 API 在非安全上下文仍可用）。
export async function copyTextToClipboard(text) {
  const value = String(text ?? "")
  if (!value) {
    return false
  }

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // 权限被拒或调用失败，继续尝试兜底方案
  }
  return copyViaExecCommand(value)
}

function copyViaExecCommand(text) {
  try {
    const textarea = document.createElement("textarea")
    textarea.value = text
    textarea.setAttribute("readonly", "")
    textarea.style.position = "fixed"
    textarea.style.top = "-1000px"
    textarea.style.opacity = "0"
    document.body.appendChild(textarea)
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    const ok = document.execCommand("copy")
    textarea.remove()
    return ok
  } catch {
    return false
  }
}
