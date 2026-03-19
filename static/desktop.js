import {
  buildViewUrl,
  collectDroppedFiles,
  collectInputFiles,
  createTransferApp,
  escapeHtml,
  formatBytes,
  formatChatTime,
  formatFileSummary,
  formatTransferSpeed,
  historyBadgeClass,
} from "./core.js?v=10"

const app = createTransferApp({
  allowMultipleFiles: true,
  allowIncomingMultiFile: true,
  enableHistory: true,
  enableResume: true,
})

const els = {
  displayName: document.querySelector("#displayName"),
  roomCode: document.querySelector("#roomCode"),
  connectBtn: document.querySelector("#connectBtn"),
  disconnectBtn: document.querySelector("#disconnectBtn"),
  fileInput: document.querySelector("#fileInput"),
  directoryInput: document.querySelector("#directoryInput"),
  sendBtn: document.querySelector("#sendBtn"),
  dropZone: document.querySelector("#dropZone"),
  selectionList: document.querySelector("#selectionList"),
  connectionBadge: document.querySelector("#connectionBadge"),
  localClientId: document.querySelector("#localClientId"),
  peerCount: document.querySelector("#peerCount"),
  peerSummary: document.querySelector("#peerSummary"),
  selectedPeerName: document.querySelector("#selectedPeerName"),
  peerList: document.querySelector("#peerList"),
  channelState: document.querySelector("#channelState"),
  sendHint: document.querySelector("#sendHint"),
  chatHint: document.querySelector("#chatHint"),
  chatPeerName: document.querySelector("#chatPeerName"),
  chatList: document.querySelector("#chatList"),
  chatInput: document.querySelector("#chatInput"),
  chatSendBtn: document.querySelector("#chatSendBtn"),
  transferActionBtn: document.querySelector("#transferActionBtn"),
  transferBadge: document.querySelector("#transferBadge"),
  transferLog: document.querySelector("#transferLog"),
  historyList: document.querySelector("#historyList"),
  pendingTransfers: document.querySelector("#pendingTransfers"),
  pendingTransferTemplate: document.querySelector("#pendingTransferTemplate"),
  peerCardTemplate: document.querySelector("#peerCardTemplate"),
  clearHistoryBtn: document.querySelector("#clearHistoryBtn"),
  openMobileLink: document.querySelector("#openMobileLink"),
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
    app.setSelectedFiles(collectInputFiles(event.target.files))
    event.target.value = ""
  })
  els.directoryInput.addEventListener("change", (event) => {
    app.setSelectedFiles(collectInputFiles(event.target.files))
    event.target.value = ""
  })
  els.sendBtn.addEventListener("click", () => app.startTransferRequest())
  els.clearHistoryBtn.addEventListener("click", () => app.clearHistory())
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
  els.dropZone.addEventListener("dragover", (event) => {
    event.preventDefault()
    els.dropZone.classList.add("active")
  })
  els.dropZone.addEventListener("dragleave", () => {
    els.dropZone.classList.remove("active")
  })
  els.dropZone.addEventListener("drop", async (event) => {
    event.preventDefault()
    els.dropZone.classList.remove("active")
    app.setSelectedFiles(await collectDroppedFiles(event.dataTransfer))
  })
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
  const chatPeer = app.getSelectedPeer()
  const chatConnection = chatPeer ? app.getConnection(chatPeer.client_id) : null
  const selectedTransferPeers = app.getSelectedTransferPeers()
  const canSend = Boolean(wsReady && selectedTransferPeers.length)
  const canChat = Boolean(wsReady && chatPeer)
  const isChatDirectReady = Boolean(chatConnection && chatConnection.channelState === "open")
  const hasDirectTransfer = selectedTransferPeers.some((peer) => {
    const connection = app.getConnection(peer.client_id)
    return Boolean(connection && connection.channelState === "open")
  })
  const hasRelayTransfer = selectedTransferPeers.some((peer) => !app.getOpenConnection(peer.client_id))
  const sendSummary = formatSelectedPeerSummary(selectedTransferPeers)

  els.connectionBadge.textContent = wsReady ? `房间 ${state.roomCode}` : "未连接"
  els.connectionBadge.className = wsReady ? "badge" : "badge muted"
  els.localClientId.textContent = state.clientId || "-"
  els.peerCount.textContent = `${state.peers.size} 台`
  els.peerSummary.textContent = sendSummary
  els.selectedPeerName.textContent = sendSummary
  els.chatPeerName.textContent = chatPeer ? chatPeer.display_name : "-"
  els.channelState.textContent = (chatConnection && chatConnection.channelState) || "-"
  els.sendHint.textContent = !canSend
    ? "等待目标设备"
    : hasDirectTransfer && hasRelayTransfer
      ? "部分设备直连可用"
      : hasDirectTransfer
        ? "可发起直连传输"
        : "可发起中继传输"
  els.sendHint.className = canSend ? "badge" : "badge muted"
  els.chatHint.textContent = isChatDirectReady ? "可直连消息" : canChat ? "可中继消息" : "等待目标设备"
  els.chatHint.className = canChat ? "badge" : "badge muted"
  els.connectBtn.disabled = wsReady
  els.disconnectBtn.disabled = !wsReady
  els.sendBtn.disabled = !(canSend && state.selectedFiles.length)
  els.chatSendBtn.disabled = !(canChat && els.chatInput.value.trim())
  renderTransferAction()

  renderPeerList()
  renderSelection()
  renderPendingTransfers()
  renderHistory()
  renderChatMessages()
  renderTransferLog()
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
    const cardButton = node.querySelector(".peer-card-button")
    const toggleButton = node.querySelector(".peer-send-toggle")
    const connection = app.getConnection(peer.client_id)
    const unread = app.getUnreadCount(peer.client_id)
    const isChatSelected = peer.client_id === app.state.selectedPeerId
    const isSendSelected = app.isTransferPeerSelected(peer.client_id)
    const channelLabel = connection
      ? connection.channelState === "open"
        ? "直连可用"
        : "中继可用"
      : "中继可用"
    node.querySelector(".peer-name").textContent = peer.display_name
    node.querySelector(".peer-meta").textContent = `${peer.client_id.slice(0, 8)} · ${(connection && connection.connectionState) || "new"}`
    node.querySelector(".peer-badge").textContent = unread ? `${channelLabel} · ${unread} 条新消息` : channelLabel
    node.querySelector(".peer-badge").classList.toggle("has-unread", unread > 0)
    toggleButton.textContent = isSendSelected ? "已选发送" : "加入发送"
    toggleButton.classList.toggle("active", isSendSelected)
    cardButton.addEventListener("click", () => app.selectPeer(peer.client_id))
    toggleButton.addEventListener("click", () => app.toggleTransferPeer(peer.client_id))
    if (isChatSelected) {
      node.classList.add("selected")
    }
    if (isSendSelected) {
      node.classList.add("send-selected")
    }
    els.peerList.append(node)
  }
}

function formatSelectedPeerSummary(peers) {
  if (!peers.length) {
    return "-"
  }
  if (peers.length === 1) {
    return peers[0].display_name
  }
  if (peers.length === 2) {
    return `${peers[0].display_name}、${peers[1].display_name}`
  }
  return `${peers[0].display_name} 等 ${peers.length} 台设备`
}

function renderSelection() {
  els.selectionList.innerHTML = ""
  if (!app.state.selectedFiles.length) {
    els.selectionList.className = "selection-list empty"
    els.selectionList.textContent = "还没有选择要发送的内容。"
    return
  }

  els.selectionList.className = "selection-list"
  app.state.selectedFiles.forEach((item, index) => {
    const row = document.createElement("div")
    row.className = "selection-item"
    row.innerHTML = `
      <div class="selection-item-header">
        <strong>${escapeHtml(item.relativePath)}</strong>
        <button type="button" class="ghost small selection-remove">删除</button>
      </div>
      <p class="selection-meta">${formatBytes(item.file.size)}</p>
    `
    row.querySelector(".selection-remove").addEventListener("click", () => app.removeSelectedFile(index))
    els.selectionList.append(row)
  })
}

function renderPendingTransfers() {
  els.pendingTransfers.innerHTML = ""
  const requests = Array.from(app.state.pendingIncomingRequests.values())
  if (!requests.length) {
    els.pendingTransfers.className = "stack empty"
    els.pendingTransfers.textContent = "当前没有待确认传输。"
    return
  }

  els.pendingTransfers.className = "stack"
  for (const request of requests) {
    const node = els.pendingTransferTemplate.content.firstElementChild.cloneNode(true)
    node.querySelector(".pending-title").textContent = `${request.peerName} -> 你`
    node.querySelector(".pending-meta").textContent =
      `${formatFileSummary(request.files)} · ${formatBytes(request.totalSize)}${request.isResume ? " · 可恢复" : ""}`
    node.querySelector(".accept-btn").addEventListener("click", () => app.acceptIncomingTransfer(request.sessionId))
    node.querySelector(".reject-btn").addEventListener("click", () => app.rejectIncomingTransfer(request.sessionId))
    els.pendingTransfers.append(node)
  }
}

function renderHistory() {
  els.historyList.innerHTML = ""
  if (!app.state.history.length) {
    els.historyList.className = "history-list empty"
    els.historyList.textContent = "还没有历史记录。"
    return
  }

  els.historyList.className = "history-list"
  for (const session of app.state.history) {
    const row = document.createElement("div")
    row.className = `history-item ${session.direction === "incoming" ? "incoming" : "outgoing"}`
    const directionLabel = session.direction === "incoming" ? "接收" : "发送"
    const targetLabel = session.direction === "incoming" ? `来自 ${session.peerName}` : `发给 ${session.peerName}`
    const timeLabel = session.completedAt ? new Date(session.completedAt).toLocaleString() : "未完成"
    row.innerHTML = `
      <div class="history-title-row">
        <strong class="history-title">${directionLabel} · ${escapeHtml(targetLabel)}</strong>
        <span class="badge ${historyBadgeClass(session.status)}">${escapeHtml(session.status)}</span>
      </div>
      <p class="history-files">${escapeHtml(formatFileSummary(session.filesMeta, 4))}</p>
      <p class="history-meta">总大小 ${formatBytes(session.totalSize)} · 完成时间 ${escapeHtml(timeLabel)}</p>
    `
    els.historyList.append(row)
  }
}

function renderChatMessages() {
  const peerId = app.state.selectedPeerId
  const peerName = peerId ? app.getPeerName(peerId) : "-"
  els.chatPeerName.textContent = peerName
  els.chatList.innerHTML = ""

  if (!peerId) {
    els.chatList.className = "chat-list empty"
    els.chatList.textContent = "先在房间设备里选择一台设备开始互发消息。"
    return
  }

  const messages = app.getChatMessages(peerId)
  if (!messages.length) {
    els.chatList.className = "chat-list empty"
    els.chatList.textContent = `和 ${peerName} 还没有消息，发一条试试。`
    return
  }

  els.chatList.className = "chat-list"
  for (const message of messages) {
    const row = document.createElement("div")
    row.className = `chat-item ${message.direction}`
    row.innerHTML = `
      <div class="chat-item-header">
        <strong>${escapeHtml(message.direction === "incoming" ? message.peerName : "你")}</strong>
        <span class="chat-time">${escapeHtml(formatChatTime(message.timestamp))}</span>
      </div>
      <p>${escapeHtml(message.text)}</p>
    `
    els.chatList.append(row)
  }
  els.chatList.scrollTop = els.chatList.scrollHeight
}

function renderTransferLog() {
  els.transferLog.innerHTML = ""
  const transferStatus = app.state.transferStatus
  if (transferStatus) {
    const row = document.createElement("div")
    row.className = "log-item progress"
    row.innerHTML = `
      <strong>${escapeHtml(transferStatus.label)} ${transferStatus.percent}%</strong>
      <div class="progress-bar"><span style="width: ${transferStatus.percent}%"></span></div>
      <p>${formatBytes(transferStatus.done)} / ${formatBytes(transferStatus.total)}</p>
      <p>速度 ${formatTransferSpeed(transferStatus.speed)}</p>
    `
    els.transferLog.append(row)
    els.transferBadge.textContent = `速度 ${formatTransferSpeed(transferStatus.speed)}`
    els.transferBadge.className = "badge"
  } else {
    els.transferBadge.textContent = "空闲"
    els.transferBadge.className = "badge muted"
  }

  for (const entry of app.state.logs) {
    const row = document.createElement("div")
    row.className = "log-item"
    const badgeClass =
      entry.level === "danger" ? "badge danger" : entry.level === "warn" ? "badge warn" : "badge muted"
    row.innerHTML = `
      <div class="section-head">
        <strong>${escapeHtml(entry.message)}</strong>
        <span class="${badgeClass}">${escapeHtml(entry.level)}</span>
      </div>
      <p>${escapeHtml(new Date(entry.timestamp).toLocaleTimeString())}</p>
    `
    els.transferLog.append(row)
  }
}

function updateSwitchLink() {
  els.openMobileLink.href = buildViewUrl("mobile", {
    roomCode: els.roomCode.value.trim(),
    displayName: els.displayName.value.trim(),
  })
}
