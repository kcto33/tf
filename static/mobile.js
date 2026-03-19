import {
  buildViewUrl,
  collectInputFiles,
  createTransferApp,
  escapeHtml,
  formatBytes,
  formatChatTime,
  formatFileSummary,
  formatTransferSpeed,
} from "./core.js"

const app = createTransferApp({
  allowMultipleFiles: false,
  allowIncomingMultiFile: false,
  enableHistory: false,
  enableResume: true,
})

const els = {
  displayName: document.querySelector("#displayName"),
  roomCode: document.querySelector("#roomCode"),
  connectBtn: document.querySelector("#connectBtn"),
  disconnectBtn: document.querySelector("#disconnectBtn"),
  fileInput: document.querySelector("#fileInput"),
  sendBtn: document.querySelector("#sendBtn"),
  connectionBadge: document.querySelector("#connectionBadge"),
  peerCount: document.querySelector("#peerCount"),
  localClientId: document.querySelector("#localClientId"),
  selectedPeerName: document.querySelector("#selectedPeerName"),
  sendHint: document.querySelector("#sendHint"),
  chatHint: document.querySelector("#chatHint"),
  transferActionBtn: document.querySelector("#transferActionBtn"),
  transferBadge: document.querySelector("#transferBadge"),
  selectionList: document.querySelector("#selectionList"),
  peerList: document.querySelector("#peerList"),
  pendingTransfers: document.querySelector("#pendingTransfers"),
  chatList: document.querySelector("#chatList"),
  chatInput: document.querySelector("#chatInput"),
  chatSendBtn: document.querySelector("#chatSendBtn"),
  statusList: document.querySelector("#statusList"),
  openDesktopLink: document.querySelector("#openDesktopLink"),
  peerCardTemplate: document.querySelector("#peerCardTemplate"),
  pendingTransferTemplate: document.querySelector("#pendingTransferTemplate"),
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeApp)
} else {
  void initializeApp()
}

window.addEventListener("error", (event) => {
  app.appendLog(`页面错误: ${event.message}`, "danger")
})

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason)
  app.appendLog(`未处理异常: ${reason}`, "danger")
})

async function initializeApp() {
  bindEvents()
  const initial = app.getInitialFormState()
  els.displayName.value = initial.displayName
  els.roomCode.value = initial.roomCode
  app.subscribe(renderAll)
  await app.initialize()
  renderAll()
}

function bindEvents() {
  els.connectBtn.addEventListener("click", () => app.connectToRoom(els.roomCode.value, els.displayName.value))
  els.disconnectBtn.addEventListener("click", () => app.disconnectFromRoom())
  els.fileInput.addEventListener("change", (event) => {
    app.setSelectedFiles(collectInputFiles(event.target.files, { allowMultipleFiles: false }))
  })
  els.sendBtn.addEventListener("click", () => app.startTransferRequest())
  els.transferActionBtn.addEventListener("click", () => app.performTransferAction())
  els.chatSendBtn.addEventListener("click", sendChatMessage)
  els.chatInput.addEventListener("input", renderAll)
  els.chatInput.addEventListener("keydown", async (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      await sendChatMessage()
    }
  })
  els.displayName.addEventListener("input", updateSwitchLink)
  els.roomCode.addEventListener("input", updateSwitchLink)
}

async function sendChatMessage() {
  const sent = await app.sendChatMessage(els.chatInput.value)
  if (sent) {
    els.chatInput.value = ""
    renderAll()
  }
}

function renderAll() {
  const wsReady = app.isConnected()
  const state = app.state
  const selectedPeer = app.getSelectedPeer()
  const selectedConnection = selectedPeer ? app.getConnection(selectedPeer.client_id) : null
  const canRelay = Boolean(wsReady && selectedPeer)
  const isDirectReady = Boolean(selectedConnection && selectedConnection.channelState === "open")

  els.connectionBadge.textContent = wsReady ? `房间 ${state.roomCode}` : "未连接"
  els.connectionBadge.className = wsReady ? "badge" : "badge muted"
  els.peerCount.textContent = `${state.peers.size} 台设备`
  els.peerCount.className = state.peers.size ? "badge" : "badge muted"
  els.localClientId.textContent = state.clientId ? state.clientId.slice(0, 8) : "-"
  els.localClientId.className = state.clientId ? "badge" : "badge muted"
  els.selectedPeerName.textContent = selectedPeer ? selectedPeer.display_name : "-"
  els.sendHint.textContent = isDirectReady ? "可直连发送" : canRelay ? "可中继发送" : "等待目标设备"
  els.sendHint.className = canRelay ? "badge" : "badge muted"
  els.chatHint.textContent = isDirectReady ? "可直连消息" : canRelay ? "可中继消息" : "等待目标设备"
  els.chatHint.className = canRelay ? "badge" : "badge muted"
  els.connectBtn.disabled = wsReady
  els.disconnectBtn.disabled = !wsReady
  els.sendBtn.disabled = !(canRelay && state.selectedFiles.length)
  els.chatSendBtn.disabled = !(canRelay && els.chatInput.value.trim())
  renderTransferAction()

  renderPeerList()
  renderPendingTransfers()
  renderSelection()
  renderChatMessages()
  renderStatusList()
  updateSwitchLink()
}

function renderTransferAction() {
  const action = app.getTransferAction()
  els.transferActionBtn.hidden = !action
  els.transferActionBtn.disabled = !action
  els.transferActionBtn.textContent = action ? action.label : "停止传输"
}

function renderPeerList() {
  els.peerList.innerHTML = ""
  if (!app.state.peers.size) {
    els.peerList.className = "peer-list empty"
    els.peerList.textContent = "房间里还没有其他设备。"
    return
  }

  els.peerList.className = "peer-list"
  for (const peer of app.state.peers.values()) {
    const node = els.peerCardTemplate.content.firstElementChild.cloneNode(true)
    const connection = app.getConnection(peer.client_id)
    const unread = app.getUnreadCount(peer.client_id)
    const badge = connection && connection.channelState === "open" ? "直连" : "中继可用"
    node.querySelector(".peer-name").textContent = peer.display_name
    node.querySelector(".peer-meta").textContent = unread ? `${peer.client_id.slice(0, 8)} · ${unread} 条新消息` : peer.client_id.slice(0, 8)
    node.querySelector(".peer-badge").textContent = badge
    node.querySelector(".peer-badge").classList.toggle("has-unread", unread > 0)
    node.addEventListener("click", () => app.selectPeer(peer.client_id))
    if (peer.client_id === app.state.selectedPeerId) {
      node.classList.add("selected")
    }
    els.peerList.append(node)
  }
}

function renderPendingTransfers() {
  els.pendingTransfers.innerHTML = ""
  const requests = Array.from(app.state.pendingIncomingRequests.values())
  if (!requests.length) {
    els.pendingTransfers.className = "pending-list empty"
    els.pendingTransfers.textContent = "当前没有待确认传输。"
    return
  }

  els.pendingTransfers.className = "pending-list"
  for (const request of requests) {
    const node = els.pendingTransferTemplate.content.firstElementChild.cloneNode(true)
    node.querySelector(".pending-title").textContent = `${request.peerName} 请求发送文件`
    node.querySelector(".pending-meta").textContent = `${formatFileSummary(request.files, 1)} · ${formatBytes(request.totalSize)}`
    node.querySelector(".accept-btn").addEventListener("click", () => app.acceptIncomingTransfer(request.sessionId))
    node.querySelector(".reject-btn").addEventListener("click", () => app.rejectIncomingTransfer(request.sessionId))
    els.pendingTransfers.append(node)
  }
}

function renderSelection() {
  els.selectionList.innerHTML = ""
  if (!app.state.selectedFiles.length) {
    els.selectionList.className = "selection-list empty"
    els.selectionList.textContent = "还没有选择文件。"
    return
  }

  els.selectionList.className = "selection-list"
  const item = app.state.selectedFiles[0]
  const node = document.createElement("div")
  node.className = "selection-item"
  node.innerHTML = `
    <strong>${escapeHtml(item.relativePath)}</strong>
    <p>${formatBytes(item.file.size)}</p>
  `
  els.selectionList.append(node)
}

function renderChatMessages() {
  const peerId = app.state.selectedPeerId
  els.chatList.innerHTML = ""
  if (!peerId) {
    els.chatList.className = "chat-list empty"
    els.chatList.textContent = "先选择一台设备开始互发消息。"
    return
  }

  const messages = app.getChatMessages(peerId)
  if (!messages.length) {
    els.chatList.className = "chat-list empty"
    els.chatList.textContent = `和 ${app.getPeerName(peerId)} 还没有消息，发一条试试。`
    return
  }

  els.chatList.className = "chat-list"
  for (const message of messages) {
    const row = document.createElement("div")
    row.className = `chat-item ${message.direction}`
    row.innerHTML = `
      <strong>${escapeHtml(message.direction === "incoming" ? message.peerName : "你")}</strong>
      <p>${escapeHtml(message.text)}</p>
      <p>${escapeHtml(formatChatTime(message.timestamp))}</p>
    `
    els.chatList.append(row)
  }
}

function renderStatusList() {
  els.statusList.innerHTML = ""
  const transferStatus = app.state.transferStatus
  if (transferStatus) {
    const statusNode = document.createElement("div")
    statusNode.className = "status-item"
    statusNode.innerHTML = `
      <strong>${escapeHtml(transferStatus.label)} ${transferStatus.percent}%</strong>
      <p>${formatBytes(transferStatus.done)} / ${formatBytes(transferStatus.total)}</p>
      <p>速度 ${formatTransferSpeed(transferStatus.speed)}</p>
    `
    els.statusList.append(statusNode)
    els.transferBadge.textContent = `速度 ${formatTransferSpeed(transferStatus.speed)}`
    els.transferBadge.className = "badge"
  } else {
    els.transferBadge.textContent = "空闲"
    els.transferBadge.className = "badge muted"
  }

  const logs = app.state.logs.slice(0, 8)
  if (!logs.length && !transferStatus) {
    els.statusList.className = "status-list empty"
    els.statusList.textContent = "进入房间后，这里会显示传输和连接状态。"
    return
  }

  els.statusList.className = "status-list"
  for (const entry of logs) {
    const node = document.createElement("div")
    node.className = "status-item"
    node.innerHTML = `
      <strong>${escapeHtml(entry.message)}</strong>
      <p>${escapeHtml(new Date(entry.timestamp).toLocaleTimeString())}</p>
    `
    els.statusList.append(node)
  }
}

function updateSwitchLink() {
  els.openDesktopLink.href = buildViewUrl("desktop", {
    roomCode: els.roomCode.value.trim(),
    displayName: els.displayName.value.trim(),
  })
}
