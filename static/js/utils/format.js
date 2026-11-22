export function formatBytes(bytes) {
  if (!bytes) {
    return "0 B"
  }
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`
}

export function formatTransferSpeed(bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond <= 0) {
    return "0 B/s"
  }
  return `${formatBytes(bytesPerSecond)}/s`
}

export function formatChatTime(timestamp) {
  return new Date(timestamp || Date.now()).toLocaleString()
}

export function formatFileSummary(filesMeta = [], limit = 3) {
  const names = filesMeta.map((file) => file.relative_path || file.relativePath || file.name || "未命名文件")
  const visible = names.slice(0, limit)
  return names.length > limit ? `${visible.join("、")} 等 ${names.length} 项` : visible.join("、")
}

export function historyBadgeClass(status) {
  if (status === "completed") {
    return ""
  }
  if (status === "cancelled") {
    return "warn"
  }
  if (status === "failed" || status === "rejected") {
    return "danger"
  }
  if (status === "pending" || status === "waiting" || status === "accepted") {
    return "warn"
  }
  return "muted"
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}
