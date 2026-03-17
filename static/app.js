const CHUNK_SIZE = 64 * 1024
const DB_NAME = "web-transfer-db"
const DB_VERSION = 1
const SESSION_STORE = "sessions"
const CHUNK_STORE = "chunks"
const MAX_BUFFERED_AMOUNT = 4 * 1024 * 1024

const state = {
  ws: null,
  db: null,
  roomCode: "",
  displayName: "",
  clientId: "",
  peers: new Map(),
  connections: new Map(),
  selectedPeerId: null,
  selectedFiles: [],
  pendingIncomingRequests: new Map(),
  outgoingSessions: new Map(),
  chatMessages: new Map(),
  unreadMessages: new Map(),
}

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
  transferBadge: document.querySelector("#transferBadge"),
  transferLog: document.querySelector("#transferLog"),
  historyList: document.querySelector("#historyList"),
  pendingTransfers: document.querySelector("#pendingTransfers"),
  pendingTransferTemplate: document.querySelector("#pendingTransferTemplate"),
  peerCardTemplate: document.querySelector("#peerCardTemplate"),
  clearHistoryBtn: document.querySelector("#clearHistoryBtn"),
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeApp)
} else {
  initializeApp()
}

window.addEventListener("error", (event) => {
  appendLog(`页面错误: ${event.message}`, "danger")
})

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason)
  appendLog(`未处理异常: ${reason}`, "danger")
})

async function initializeApp() {
  bindEvents()
  restoreFormState()
  try {
    state.db = await openDatabase()
    await renderHistory()
  } catch (error) {
    appendLog(`本地存储初始化失败: ${error.message}`, "warn")
    els.historyList.className = "history-list empty"
    els.historyList.textContent = "本地历史不可用，但当前会话仍可使用。"
  }
  renderSelection()
  renderPendingTransfers()
  renderPeerList()
  renderChatMessages()
  syncStatus()
}

function bindEvents() {
  els.connectBtn.addEventListener("click", connectToRoom)
  els.disconnectBtn.addEventListener("click", disconnectFromRoom)
  els.fileInput.addEventListener("change", (event) => {
    state.selectedFiles = collectInputFiles(event.target.files)
    renderSelection()
  })
  els.directoryInput.addEventListener("change", (event) => {
    state.selectedFiles = collectInputFiles(event.target.files)
    renderSelection()
  })
  els.sendBtn.addEventListener("click", startTransferRequest)
  els.chatSendBtn.addEventListener("click", sendChatMessage)
  els.chatInput.addEventListener("input", syncStatus)
  els.chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      void sendChatMessage()
    }
  })
  els.clearHistoryBtn.addEventListener("click", clearHistory)
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
    state.selectedFiles = await collectDroppedFiles(event.dataTransfer)
    renderSelection()
  })
}

function restoreFormState() {
  const savedName = localStorage.getItem("web-transfer-display-name")
  if (savedName) {
    els.displayName.value = savedName
  }
  const savedRoom = localStorage.getItem("web-transfer-room-code")
  if (savedRoom) {
    els.roomCode.value = savedRoom
  }
}

async function connectToRoom() {
  try {
    const roomCode = els.roomCode.value.trim()
    const displayName = els.displayName.value.trim() || `PC-${Math.floor(Math.random() * 1000)}`
    if (!roomCode) {
      appendLog("请输入房间码。", "warn")
      return
    }

    disconnectFromRoom()
    state.roomCode = roomCode
    state.displayName = displayName
    state.clientId = makeId()
    localStorage.setItem("web-transfer-display-name", displayName)
    localStorage.setItem("web-transfer-room-code", roomCode)

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
    state.ws = new WebSocket(`${protocol}//${window.location.host}/ws/signaling`)

    state.ws.addEventListener("open", () => {
      sendSignal({
        type: "join_room",
        room_code: roomCode,
        client_id: state.clientId,
        display_name: displayName,
      })
      appendLog(`已进入房间 ${roomCode}。`, "info")
      syncStatus()
    })

    state.ws.addEventListener("message", async (event) => {
      await handleSignalMessage(JSON.parse(event.data))
    })

    state.ws.addEventListener("error", () => {
      appendLog("信令连接失败。请确认访问的是正确 IP 和端口。", "danger")
    })

    state.ws.addEventListener("close", () => {
      appendLog("信令连接已断开。", "warn")
      resetRoomState()
      syncStatus()
    })
  } catch (error) {
    appendLog(`进入房间失败: ${error.message}`, "danger")
  }
}

function disconnectFromRoom() {
  if (state.ws) {
    state.ws.close()
    state.ws = null
  }
  resetRoomState()
  syncStatus()
}

function resetRoomState() {
  closeAllPeerConnections()
  state.peers.clear()
  state.connections.clear()
  state.pendingIncomingRequests.clear()
  state.chatMessages.clear()
  state.unreadMessages.clear()
  state.selectedPeerId = null
  els.localClientId.textContent = "-"
  els.chatInput.value = ""
  renderPeerList()
  renderChatMessages()
  renderPendingTransfers()
}

async function handleSignalMessage(message) {
  switch (message.type) {
    case "joined_room":
      els.localClientId.textContent = message.client_id
      for (const peer of message.peers) {
        upsertPeer(peer)
        await ensurePeerConnection(peer.client_id, state.clientId.localeCompare(peer.client_id) < 0)
      }
      pickFallbackPeer()
      await resumePendingSessions()
      syncStatus()
      renderPeerList()
      break
    case "peer_joined":
      upsertPeer({ client_id: message.client_id, display_name: message.display_name })
      appendLog(`设备 ${message.display_name} 已进入房间。`, "info")
      await ensurePeerConnection(message.client_id, state.clientId.localeCompare(message.client_id) < 0)
      pickFallbackPeer()
      await resumePendingSessions(message.client_id)
      syncStatus()
      renderPeerList()
      break
    case "peer_left":
      const leftPeer = state.peers.get(message.client_id)
      appendLog(`设备 ${(leftPeer && leftPeer.display_name) || message.client_id} 已离开。`, "warn")
      removePeer(message.client_id)
      syncStatus()
      renderPeerList()
      break
    case "webrtc_offer":
      await onOffer(message)
      break
    case "webrtc_answer":
      await onAnswer(message)
      break
    case "ice_candidate":
      await onIceCandidate(message)
      break
    case "transfer_request":
      await onTransferRequest(message)
      break
    case "transfer_accept":
      await onTransferAccept(message)
      break
    case "transfer_reject":
      await onTransferReject(message)
      break
    case "resume_request":
      await onResumeRequest(message)
      break
    case "resume_state":
      await onResumeState(message)
      break
    case "error":
      appendLog(message.message, "danger")
      break
    default:
      appendLog(`忽略未知信令消息 ${message.type}。`, "warn")
  }
}

function upsertPeer(peer) {
  if (!peer || !peer.client_id || peer.client_id === state.clientId) {
    return
  }
  state.peers.set(peer.client_id, {
    client_id: peer.client_id,
    display_name: peer.display_name || peer.client_id,
  })
}

function removePeer(peerId) {
  state.peers.delete(peerId)
  closePeerConnection(peerId)
  for (const request of state.pendingIncomingRequests.values()) {
    if (request.fromClientId === peerId) {
      state.pendingIncomingRequests.delete(request.sessionId)
    }
  }
  if (state.selectedPeerId === peerId) {
    state.selectedPeerId = null
    pickFallbackPeer()
  }
  renderPendingTransfers()
  renderChatMessages()
}

function pickFallbackPeer() {
  if (state.selectedPeerId && state.peers.has(state.selectedPeerId)) {
    return
  }
  const previousPeerId = state.selectedPeerId
  const nextPeerCandidate = state.peers.keys().next().value
  const nextPeer = nextPeerCandidate === undefined ? null : nextPeerCandidate
  state.selectedPeerId = nextPeer
  if (previousPeerId !== nextPeer) {
    renderChatMessages()
  }
}

function selectPeer(peerId) {
  if (!state.peers.has(peerId)) {
    return
  }
  state.selectedPeerId = peerId
  state.unreadMessages.set(peerId, 0)
  renderPeerList()
  renderChatMessages()
  syncStatus()
}

async function ensurePeerConnection(peerId, initiator) {
  if (!state.peers.has(peerId)) {
    return null
  }
  let connection = state.connections.get(peerId)
  if (connection) {
    return connection
  }

  const pc = new RTCPeerConnection({ iceServers: [] })
  connection = {
    peerId,
    pc,
    channel: null,
    expectedChunkHeader: null,
    connectionState: "new",
    channelState: "idle",
    sendingSessionId: null,
  }
  state.connections.set(peerId, connection)

  pc.onicecandidate = (event) => {
    if (!event.candidate) {
      return
    }
    sendSignal({
      type: "ice_candidate",
      target_client_id: peerId,
      candidate: event.candidate,
    })
  }

  pc.onconnectionstatechange = () => {
    connection.connectionState = pc.connectionState || "new"
    if (["failed", "disconnected", "closed"].includes(connection.connectionState)) {
      appendLog(`${getPeerName(peerId)} 连接状态: ${connection.connectionState}`, "warn")
    }
    renderPeerList()
    syncStatus()
  }

  pc.ondatachannel = (event) => {
    attachDataChannel(peerId, event.channel)
  }

  if (initiator) {
    attachDataChannel(peerId, pc.createDataChannel("file-transfer", { ordered: true }))
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    sendSignal({
      type: "webrtc_offer",
      target_client_id: peerId,
      sdp: offer,
    })
  }

  renderPeerList()
  syncStatus()
  return connection
}

async function onOffer(message) {
  const connection = await ensurePeerConnection(message.from_client_id, false)
  await connection.pc.setRemoteDescription(message.sdp)
  const answer = await connection.pc.createAnswer()
  await connection.pc.setLocalDescription(answer)
  sendSignal({
    type: "webrtc_answer",
    target_client_id: message.from_client_id,
    sdp: answer,
  })
}

async function onAnswer(message) {
  const connection = state.connections.get(message.from_client_id)
  if (!connection) {
    return
  }
  await connection.pc.setRemoteDescription(message.sdp)
}

async function onIceCandidate(message) {
  const connection = state.connections.get(message.from_client_id)
  if (!connection || !message.candidate) {
    return
  }
  await connection.pc.addIceCandidate(message.candidate)
}

function attachDataChannel(peerId, channel) {
  const connection = state.connections.get(peerId)
  if (!connection) {
    return
  }

  connection.channel = channel
  connection.channelState = channel.readyState
  channel.binaryType = "arraybuffer"

  channel.onopen = async () => {
    connection.channelState = "open"
    appendLog(`${getPeerName(peerId)} 的传输通道已打开。`, "info")
    renderPeerList()
    syncStatus()
    await resumePendingSessions(peerId)
  }

  channel.onclose = () => {
    connection.channelState = "closed"
    connection.sendingSessionId = null
    appendLog(`${getPeerName(peerId)} 的传输通道已关闭。`, "warn")
    renderPeerList()
    syncStatus()
  }

  channel.onerror = () => {
    connection.channelState = "error"
    renderPeerList()
    syncStatus()
  }

  channel.onmessage = async (event) => {
    await handleChannelMessage(peerId, event.data)
  }

  renderPeerList()
  syncStatus()
}

function closePeerConnection(peerId) {
  const connection = state.connections.get(peerId)
  if (!connection) {
    return
  }
  try {
    if (connection.channel) {
      connection.channel.close()
    }
  } catch (error) {
    void error
  }
  try {
    if (connection.pc) {
      connection.pc.close()
    }
  } catch (error) {
    void error
  }
  state.connections.delete(peerId)
}

function closeAllPeerConnections() {
  for (const peerId of Array.from(state.connections.keys())) {
    closePeerConnection(peerId)
  }
}

function getPeerName(peerId) {
  const peer = state.peers.get(peerId)
  return (peer && peer.display_name) || peerId
}

function getConnection(peerId) {
  return state.connections.has(peerId) ? state.connections.get(peerId) : null
}

function getOpenConnection(peerId) {
  const connection = getConnection(peerId)
  if (!connection || !connection.channel || connection.channel.readyState !== "open") {
    return null
  }
  return connection
}

function getChatMessages(peerId) {
  return state.chatMessages.get(peerId) || []
}

function pushChatMessage(peerId, message) {
  const existing = getChatMessages(peerId)
  const next = existing.concat(message).slice(-200)
  state.chatMessages.set(peerId, next)
}

async function sendChatMessage() {
  const peerId = state.selectedPeerId
  if (!peerId) {
    appendLog("先选择一个设备，再发送消息。", "warn")
    return
  }

  const connection = getOpenConnection(peerId)
  if (!connection) {
    appendLog("目标设备的消息通道尚未准备好。", "warn")
    return
  }

  const text = els.chatInput.value.trim()
  if (!text) {
    return
  }

  const timestamp = Date.now()
  sendDataControl(connection.channel, {
    type: "chat_message",
    message_id: makeId(),
    text,
    sent_at: timestamp,
  })

  pushChatMessage(peerId, {
    id: makeId(),
    direction: "outgoing",
    peerName: getPeerName(peerId),
    text,
    timestamp,
  })
  els.chatInput.value = ""
  renderChatMessages()
  syncStatus()
}

async function startTransferRequest() {
  try {
    const peerId = state.selectedPeerId
    if (!peerId) {
      appendLog("先在房间设备列表里选择一个发送对象。", "warn")
      return
    }
    const connection = getOpenConnection(peerId)
    if (!connection) {
      appendLog("所选设备的传输通道还没有准备好。", "warn")
      return
    }
    if (!state.selectedFiles.length) {
      appendLog("先选择要发送的文件或文件夹。", "warn")
      return
    }

    els.sendBtn.disabled = true
    els.transferBadge.textContent = "准备中"
    els.transferBadge.className = "badge warn"

    const files = []
    let totalSize = 0
    for (const item of state.selectedFiles) {
      const fileId = makeId()
      const sha256 = await hashFile(item.file)
      const chunkCount = Math.max(Math.ceil(item.file.size / CHUNK_SIZE), 1)
      files.push({
        file_id: fileId,
        relative_path: item.relativePath,
        size: item.file.size,
        sha256,
        chunk_size: CHUNK_SIZE,
        chunk_count: chunkCount,
        file: item.file,
      })
      totalSize += item.file.size
    }

    const sessionId = makeId()
    const session = {
      sessionId,
      peerClientId: peerId,
      peerName: getPeerName(peerId),
      files,
      totalSize,
      sentBytes: 0,
      sending: false,
      accepted: false,
    }
    state.outgoingSessions.set(sessionId, session)

    await upsertSessionRecord({
      sessionId,
      direction: "outgoing",
      status: "waiting",
      roomCode: state.roomCode,
      peerClientId: peerId,
      peerName: session.peerName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null,
      fileCount: files.length,
      totalSize,
      filesMeta: files.map(stripFileHandle),
      completedChunks: {},
    })

    sendSignal({
      type: "transfer_request",
      target_client_id: peerId,
      session_id: sessionId,
      total_size: totalSize,
      files: files.map(stripFileHandle),
    })

    appendLog(`已向 ${session.peerName} 发起传输请求。`, "info")
    await renderHistory()
  } catch (error) {
    appendLog(`准备传输失败: ${error.message}`, "danger")
  } finally {
    els.sendBtn.disabled = false
    syncStatus()
  }
}

async function onTransferRequest(message) {
  const peerName = getPeerName(message.from_client_id)
  const existing = await getSessionRecord(message.session_id)
  state.pendingIncomingRequests.set(message.session_id, {
    sessionId: message.session_id,
    fromClientId: message.from_client_id,
    peerName,
    files: message.files,
    totalSize: message.total_size,
    isResume: existing && existing.status === "pending",
  })
  renderPendingTransfers()
  appendLog(`${peerName} 请求发送 ${message.files.length} 个项目。`, "info")
}

async function acceptIncomingTransfer(sessionId) {
  const request = state.pendingIncomingRequests.get(sessionId)
  if (!request) {
    return
  }

  let session = await getSessionRecord(sessionId)
  if (!session) {
    session = {
      sessionId,
      direction: "incoming",
      status: "pending",
      roomCode: state.roomCode,
      peerClientId: request.fromClientId,
      peerName: request.peerName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null,
      fileCount: request.files.length,
      totalSize: request.totalSize,
      filesMeta: request.files,
      completedChunks: {},
    }
  } else {
    session = {
      ...session,
      status: "pending",
      updatedAt: Date.now(),
      peerClientId: request.fromClientId,
      peerName: request.peerName,
      filesMeta: request.files,
      fileCount: request.files.length,
      totalSize: request.totalSize,
    }
  }

  await upsertSessionRecord(session)
  sendSignal({
    type: "transfer_accept",
    target_client_id: request.fromClientId,
    session_id: sessionId,
  })
  sendSignal({
    type: "resume_state",
    target_client_id: request.fromClientId,
    session_id: sessionId,
    files: request.files.map((file) => ({
      file_id: file.file_id,
      completed_chunks: ((session.completedChunks && session.completedChunks[file.file_id]) || []).slice(),
    })),
  })

  state.pendingIncomingRequests.delete(sessionId)
  renderPendingTransfers()
  appendLog(`已接受 ${request.peerName} 的传输请求。`, "info")
  await renderHistory()
}

async function rejectIncomingTransfer(sessionId) {
  const request = state.pendingIncomingRequests.get(sessionId)
  if (!request) {
    return
  }

  sendSignal({
    type: "transfer_reject",
    target_client_id: request.fromClientId,
    session_id: sessionId,
  })
  await upsertSessionRecord({
    sessionId,
    direction: "incoming",
    status: "rejected",
    roomCode: state.roomCode,
    peerClientId: request.fromClientId,
    peerName: request.peerName,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    fileCount: request.files.length,
    totalSize: request.totalSize,
    filesMeta: request.files,
    completedChunks: {},
  })

  state.pendingIncomingRequests.delete(sessionId)
  renderPendingTransfers()
  await renderHistory()
}

async function onTransferAccept(message) {
  const session = state.outgoingSessions.get(message.session_id)
  if (!session) {
    return
  }
  session.accepted = true
  appendLog(`${session.peerName} 已确认接收。`, "info")
  await updateSessionRecord(message.session_id, {
    status: "accepted",
    updatedAt: Date.now(),
  })
  await renderHistory()
}

async function onTransferReject(message) {
  const session = state.outgoingSessions.get(message.session_id)
  if (!session) {
    return
  }
  appendLog(`${session.peerName} 已拒绝接收。`, "warn")
  await updateSessionRecord(message.session_id, {
    status: "rejected",
    updatedAt: Date.now(),
  })
  state.outgoingSessions.delete(message.session_id)
  await renderHistory()
}

async function onResumeRequest(message) {
  const session = state.outgoingSessions.get(message.session_id)
  if (!session) {
    appendLog(`恢复请求找不到发送会话 ${message.session_id}。`, "warn")
    return
  }
  sendSignal({
    type: "transfer_request",
    target_client_id: message.from_client_id,
    session_id: session.sessionId,
    total_size: session.totalSize,
    files: session.files.map(stripFileHandle),
  })
}

async function onResumeState(message) {
  const session = state.outgoingSessions.get(message.session_id)
  if (!session) {
    return
  }
  const completedMap = new Map()
  for (const fileState of message.files || []) {
    completedMap.set(fileState.file_id, new Set(fileState.completed_chunks || []))
  }
  await sendOutgoingSession(session, completedMap)
}

async function sendOutgoingSession(session, completedMap) {
  if (session.sending) {
    return
  }
  const connection = getOpenConnection(session.peerClientId)
  if (!connection) {
    throw new Error(`设备 ${session.peerName} 的传输通道未就绪。`)
  }
  if (connection.sendingSessionId && connection.sendingSessionId !== session.sessionId) {
    appendLog(`${session.peerName} 当前已有其他传输进行中。`, "warn")
    return
  }

  session.sending = true
  session.sentBytes = 0
  connection.sendingSessionId = session.sessionId

  try {
    await waitForChannelOpen(connection)
    await updateSessionRecord(session.sessionId, {
      status: "sending",
      updatedAt: Date.now(),
    })
    renderTransferProgress(session.sentBytes, session.totalSize, `发送到 ${session.peerName}`)

    sendDataControl(connection.channel, {
      type: "session_start",
      session_id: session.sessionId,
      total_size: session.totalSize,
      file_count: session.files.length,
    })

    for (const fileMeta of session.files) {
      const completedChunks = completedMap.has(fileMeta.file_id) ? completedMap.get(fileMeta.file_id) : new Set()
      sendDataControl(connection.channel, {
        type: "file_start",
        session_id: session.sessionId,
        file_id: fileMeta.file_id,
        relative_path: fileMeta.relative_path,
        size: fileMeta.size,
        chunk_count: fileMeta.chunk_count,
        sha256: fileMeta.sha256,
      })

      for (let chunkIndex = 0; chunkIndex < fileMeta.chunk_count; chunkIndex += 1) {
        const chunkSize = Math.min(CHUNK_SIZE, Math.max(fileMeta.size - chunkIndex * CHUNK_SIZE, 0))
        if (completedChunks.has(chunkIndex)) {
          session.sentBytes += chunkSize
          renderTransferProgress(session.sentBytes, session.totalSize, `发送到 ${session.peerName}`)
          continue
        }

        const start = chunkIndex * CHUNK_SIZE
        const end = Math.min(start + CHUNK_SIZE, fileMeta.size)
        const buffer = await fileMeta.file.slice(start, end).arrayBuffer()
        sendDataControl(connection.channel, {
          type: "chunk",
          session_id: session.sessionId,
          file_id: fileMeta.file_id,
          chunk_index: chunkIndex,
          size: buffer.byteLength,
        })
        await waitForBufferedAmount(connection.channel, buffer.byteLength)
        connection.channel.send(buffer)
        session.sentBytes += buffer.byteLength
        renderTransferProgress(session.sentBytes, session.totalSize, `发送到 ${session.peerName}`)
      }

      sendDataControl(connection.channel, {
        type: "file_end",
        session_id: session.sessionId,
        file_id: fileMeta.file_id,
        sha256: fileMeta.sha256,
      })
    }

    sendDataControl(connection.channel, {
      type: "session_complete",
      session_id: session.sessionId,
    })

    appendLog(`发送完成: ${session.peerName}。`, "info")
    await updateSessionRecord(session.sessionId, {
      status: "completed",
      updatedAt: Date.now(),
      completedAt: Date.now(),
    })
    await renderHistory()
  } catch (error) {
    appendLog(`发送中断: ${error.message}`, "danger")
    await updateSessionRecord(session.sessionId, {
      status: "pending",
      updatedAt: Date.now(),
    })
    await renderHistory()
  } finally {
    session.sending = false
    connection.sendingSessionId = null
    els.transferBadge.textContent = "空闲"
    els.transferBadge.className = "badge muted"
  }
}

async function handleChannelMessage(peerId, payload) {
  const connection = getConnection(peerId)
  if (!connection) {
    return
  }

  if (typeof payload === "string") {
    const message = JSON.parse(payload)
    switch (message.type) {
      case "session_start":
        appendLog(`开始接收 ${getPeerName(peerId)} 的会话 ${message.session_id}。`, "info")
        break
      case "chat_message":
        onChatMessage(peerId, message)
        break
      case "file_start":
        appendLog(`开始接收 ${message.relative_path}。`, "info")
        break
      case "chunk":
        connection.expectedChunkHeader = message
        break
      case "file_end":
        await finalizeIncomingFile(message)
        break
      case "session_complete":
        await finalizeIncomingSession(message.session_id)
        break
      default:
        appendLog(`忽略未知数据通道消息 ${message.type}。`, "warn")
    }
    return
  }

  if (!connection.expectedChunkHeader) {
    appendLog("收到未匹配头信息的二进制数据。", "warn")
    return
  }

  const header = connection.expectedChunkHeader
  connection.expectedChunkHeader = null
  await storeIncomingChunk(header, payload)
}

function onChatMessage(peerId, message) {
  pushChatMessage(peerId, {
    id: message.message_id || makeId(),
    direction: "incoming",
    peerName: getPeerName(peerId),
    text: message.text || "",
    timestamp: Number(message.sent_at) || Date.now(),
  })
  if (state.selectedPeerId !== peerId) {
    const unread = state.unreadMessages.get(peerId) || 0
    state.unreadMessages.set(peerId, unread + 1)
    appendLog(`${getPeerName(peerId)} 发来了一条新消息。`, "info")
  }
  renderPeerList()
  renderChatMessages()
}

async function storeIncomingChunk(header, buffer) {
  const session = await getSessionRecord(header.session_id)
  if (!session) {
    return
  }

  const completed = objectToSets(session.completedChunks)
  const fileSet = completed[header.file_id] || new Set()
  if (fileSet.has(header.chunk_index)) {
    return
  }

  await putChunk({
    chunkKey: makeChunkKey(header.session_id, header.file_id, header.chunk_index),
    sessionId: header.session_id,
    fileId: header.file_id,
    chunkIndex: header.chunk_index,
    data: buffer,
  })

  fileSet.add(header.chunk_index)
  completed[header.file_id] = fileSet
  await updateSessionRecord(header.session_id, {
    status: "pending",
    updatedAt: Date.now(),
    completedChunks: setsToObject(completed),
  })

  const progress = calculateIncomingProgress(session.filesMeta, completed)
  renderTransferProgress(progress.done, progress.total, `接收自 ${session.peerName}`)
}

async function finalizeIncomingFile(message) {
  const session = await getSessionRecord(message.session_id)
  if (!session) {
    return
  }
  const fileMeta = session.filesMeta.find((item) => item.file_id === message.file_id)
  if (!fileMeta) {
    return
  }

  const blob = await buildBlobFromChunks(message.session_id, fileMeta.file_id)
  const checksum = await hashBlob(blob)
  if (checksum !== fileMeta.sha256) {
    appendLog(`文件校验失败: ${fileMeta.relative_path}`, "danger")
    await updateSessionRecord(message.session_id, {
      status: "failed",
      updatedAt: Date.now(),
      completedAt: null,
    })
    await renderHistory()
    return
  }
  appendLog(`文件校验通过: ${fileMeta.relative_path}`, "info")
}

async function finalizeIncomingSession(sessionId) {
  const session = await getSessionRecord(sessionId)
  if (!session) {
    return
  }
  if (session.status === "failed") {
    appendLog(`会话 ${sessionId.slice(0, 8)} 校验失败，已停止保存。`, "danger")
    return
  }

  const files = []
  for (const fileMeta of session.filesMeta) {
    const blob = await buildBlobFromChunks(sessionId, fileMeta.file_id)
    files.push({
      name: fileMeta.relative_path,
      bytes: new Uint8Array(await blob.arrayBuffer()),
    })
  }

  if (files.length === 1 && !files[0].name.includes("/")) {
    downloadBlob(new Blob([files[0].bytes]), files[0].name)
  } else {
    downloadBlob(createStoredZip(files), `transfer-${sessionId.slice(0, 8)}.zip`)
  }

  await updateSessionRecord(sessionId, {
    status: "completed",
    updatedAt: Date.now(),
    completedAt: Date.now(),
  })
  await clearChunksBySession(sessionId)
  appendLog(`接收完成，已保存来自 ${session.peerName} 的文件。`, "info")
  els.transferBadge.textContent = "空闲"
  els.transferBadge.className = "badge muted"
  await renderHistory()
}

async function resumePendingSessions(targetPeerId = null) {
  if (!state.ws) {
    return
  }
  const pendingSessions = await listSessionsByStatus("pending")
  for (const session of pendingSessions) {
    if (session.direction !== "incoming" || session.roomCode !== state.roomCode) {
      continue
    }
    if (targetPeerId && session.peerClientId !== targetPeerId) {
      continue
    }
    if (!state.peers.has(session.peerClientId)) {
      continue
    }
    sendSignal({
      type: "resume_request",
      target_client_id: session.peerClientId,
      session_id: session.sessionId,
    })
  }
}

function collectInputFiles(fileList) {
  return Array.from(fileList || []).map((file) => ({
    file,
    relativePath: file.webkitRelativePath || file.name,
  }))
}

async function collectDroppedFiles(dataTransfer) {
  const items = Array.from((dataTransfer && dataTransfer.items) || [])
  if (!items.length) {
    return collectInputFiles((dataTransfer && dataTransfer.files) || [])
  }

  const allFiles = []
  for (const item of items) {
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null
    if (entry) {
      allFiles.push(...(await walkEntry(entry)))
      continue
    }
    const file = item.getAsFile ? item.getAsFile() : null
    if (file) {
      allFiles.push({ file, relativePath: file.name })
    }
  }
  return allFiles
}

function walkEntry(entry, prefix = "") {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file) => resolve([{ file, relativePath: prefix + file.name }]))
      return
    }
    if (!entry.isDirectory) {
      resolve([])
      return
    }

    const reader = entry.createReader()
    const collected = []
    const readBatch = () => {
      reader.readEntries(async (entries) => {
        if (!entries.length) {
          resolve(collected)
          return
        }
        for (const child of entries) {
          collected.push(...(await walkEntry(child, `${prefix}${entry.name}/`)))
        }
        readBatch()
      })
    }
    readBatch()
  })
}

function sendSignal(payload) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    throw new Error("WebSocket 未连接。")
  }
  state.ws.send(JSON.stringify(payload))
}

function sendDataControl(channel, payload) {
  if (!channel || channel.readyState !== "open") {
    throw new Error("DataChannel 未打开。")
  }
  channel.send(JSON.stringify(payload))
}

async function waitForChannelOpen(connection) {
  if (connection.channel && connection.channel.readyState === "open") {
    return
  }
  await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("等待传输通道超时。")), 12000)
    const timer = window.setInterval(() => {
      if (connection.channel && connection.channel.readyState === "open") {
        window.clearTimeout(timeout)
        window.clearInterval(timer)
        resolve()
      }
    }, 200)
  })
}

async function waitForBufferedAmount(channel, nextSize) {
  while (channel.bufferedAmount + nextSize > MAX_BUFFERED_AMOUNT) {
    await delay(40)
  }
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function renderPeerList() {
  els.peerList.innerHTML = ""
  if (!state.peers.size) {
    els.peerList.className = "peer-list empty"
    els.peerList.textContent = "房间里还没有其他设备。"
    return
  }

  els.peerList.className = "peer-list"
  for (const peer of state.peers.values()) {
    const node = els.peerCardTemplate.content.firstElementChild.cloneNode(true)
    const connection = getConnection(peer.client_id)
    const unread = state.unreadMessages.get(peer.client_id) || 0
    const channelLabel = connection ? (connection.channelState === "open" ? "可发送" : connection.channelState || "等待连接") : "等待连接"
    node.querySelector(".peer-name").textContent = peer.display_name
    node.querySelector(".peer-meta").textContent = `${peer.client_id.slice(0, 8)} · ${(connection && connection.connectionState) || "new"}`
    node.querySelector(".peer-badge").textContent = unread ? `${channelLabel} · ${unread} 条新消息` : channelLabel
    node.querySelector(".peer-badge").classList.toggle("has-unread", unread > 0)
    node.addEventListener("click", () => selectPeer(peer.client_id))
    if (peer.client_id === state.selectedPeerId) {
      node.classList.add("selected")
    }
    els.peerList.append(node)
  }
}

function renderSelection() {
  els.selectionList.innerHTML = ""
  if (!state.selectedFiles.length) {
    els.selectionList.classList.add("empty")
    els.selectionList.textContent = "还没有选择要发送的内容。"
  } else {
    els.selectionList.classList.remove("empty")
    for (const item of state.selectedFiles) {
      const row = document.createElement("div")
      row.className = "selection-item"
      row.innerHTML = `
        <strong>${escapeHtml(item.relativePath)}</strong>
        <p class="selection-meta">${formatBytes(item.file.size)}</p>
      `
      els.selectionList.append(row)
    }
  }
  syncStatus()
}

function renderPendingTransfers() {
  els.pendingTransfers.innerHTML = ""
  if (!state.pendingIncomingRequests.size) {
    els.pendingTransfers.className = "stack empty"
    els.pendingTransfers.textContent = "当前没有待确认传输。"
    return
  }

  els.pendingTransfers.className = "stack"
  for (const request of state.pendingIncomingRequests.values()) {
    const node = els.pendingTransferTemplate.content.firstElementChild.cloneNode(true)
    node.querySelector(".pending-title").textContent = `${request.peerName} -> 你`
    node.querySelector(".pending-meta").textContent =
      `${formatFileSummary(request.files)} · ${formatBytes(request.totalSize)}${request.isResume ? " · 可恢复" : ""}`
    node.querySelector(".accept-btn").addEventListener("click", () => acceptIncomingTransfer(request.sessionId))
    node.querySelector(".reject-btn").addEventListener("click", () => rejectIncomingTransfer(request.sessionId))
    els.pendingTransfers.append(node)
  }
}

async function renderHistory() {
  const sessions = await listRecentSessions()
  els.historyList.innerHTML = ""
  if (!sessions.length) {
    els.historyList.className = "history-list empty"
    els.historyList.textContent = "还没有历史记录。"
    return
  }

  els.historyList.className = "history-list"
  for (const session of sessions) {
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
  const peerId = state.selectedPeerId
  const peerName = peerId ? getPeerName(peerId) : "-"
  els.chatPeerName.textContent = peerName
  els.chatList.innerHTML = ""

  if (!peerId) {
    els.chatList.className = "chat-list empty"
    els.chatList.textContent = "先在房间设备里选择一台设备开始互发消息。"
    return
  }

  const messages = getChatMessages(peerId)
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

function syncStatus() {
  const wsReady = state.ws && state.ws.readyState === WebSocket.OPEN
  const selectedPeer = state.selectedPeerId ? state.peers.get(state.selectedPeerId) : null
  const selectedConnection = state.selectedPeerId ? getConnection(state.selectedPeerId) : null

  els.connectionBadge.textContent = wsReady ? `房间 ${state.roomCode}` : "未连接"
  els.connectionBadge.className = wsReady ? "badge" : "badge muted"
  els.peerCount.textContent = `${state.peers.size} 台`
  els.peerSummary.textContent = selectedPeer ? `${selectedPeer.display_name}` : "-"
  els.selectedPeerName.textContent = selectedPeer ? selectedPeer.display_name : "-"
  els.channelState.textContent = (selectedConnection && selectedConnection.channelState) || "-"
  els.sendHint.textContent = selectedConnection && selectedConnection.channelState === "open" ? "可发起传输" : "等待目标设备"
  els.sendHint.className = selectedConnection && selectedConnection.channelState === "open" ? "badge" : "badge muted"
  els.chatHint.textContent = selectedConnection && selectedConnection.channelState === "open" ? "可互发消息" : "等待目标设备"
  els.chatHint.className = selectedConnection && selectedConnection.channelState === "open" ? "badge" : "badge muted"
  els.connectBtn.disabled = wsReady
  els.disconnectBtn.disabled = !wsReady
  els.sendBtn.disabled = !(wsReady && selectedConnection && selectedConnection.channelState === "open" && state.selectedFiles.length)
  els.chatSendBtn.disabled = !(wsReady && selectedConnection && selectedConnection.channelState === "open" && els.chatInput.value.trim())
}

function appendLog(message, level = "info") {
  if (!message) {
    return
  }
  const row = document.createElement("div")
  row.className = "log-item"
  const badgeClass =
    level === "danger" ? "badge danger" : level === "warn" ? "badge warn" : "badge muted"
  row.innerHTML = `
    <div class="section-head">
      <strong>${escapeHtml(message)}</strong>
      <span class="${badgeClass}">${escapeHtml(level)}</span>
    </div>
    <p>${escapeHtml(new Date().toLocaleTimeString())}</p>
  `
  els.transferLog.prepend(row)
}

function renderTransferProgress(done, total, label) {
  const percent = total ? Math.round((done / total) * 100) : 0
  els.transferBadge.textContent = `${label} ${percent}%`
  els.transferBadge.className = "badge"

  const row = document.createElement("div")
  row.className = "log-item progress"
  row.innerHTML = `
    <strong>${escapeHtml(label)} ${percent}%</strong>
    <div class="progress-bar"><span style="width: ${percent}%"></span></div>
    <p>${formatBytes(done)} / ${formatBytes(total)}</p>
  `

  const existing = els.transferLog.querySelector(".log-item.progress")
  if (existing) {
    existing.replaceWith(row)
  } else {
    els.transferLog.prepend(row)
  }
}

function stripFileHandle(fileMeta) {
  return {
    file_id: fileMeta.file_id,
    relative_path: fileMeta.relative_path,
    size: fileMeta.size,
    sha256: fileMeta.sha256,
    chunk_size: fileMeta.chunk_size,
    chunk_count: fileMeta.chunk_count,
  }
}

function formatBytes(bytes) {
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

function formatChatTime(timestamp) {
  const date = new Date(timestamp || Date.now())
  return date.toLocaleString()
}

function formatFileSummary(filesMeta = [], limit = 3) {
  const names = filesMeta.map((file) => file.relative_path || file.name || "未命名文件")
  const visible = names.slice(0, limit)
  return names.length > limit ? `${visible.join("、")} 等 ${names.length} 项` : visible.join("、")
}

function historyBadgeClass(status) {
  if (status === "completed") {
    return ""
  }
  if (status === "failed" || status === "rejected") {
    return "danger"
  }
  if (status === "pending" || status === "waiting" || status === "accepted") {
    return "warn"
  }
  return "muted"
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function makeId() {
  if (globalThis.crypto && globalThis.crypto.randomUUID) {
    return globalThis.crypto.randomUUID()
  }

  const bytes = new Uint8Array(16)
  if (globalThis.crypto && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (item) => item.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function hashFile(file) {
  return hashBlob(file)
}

async function hashBlob(blob) {
  const buffer = await blob.arrayBuffer()
  if (globalThis.crypto && globalThis.crypto.subtle && globalThis.crypto.subtle.digest) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer)
    return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("")
  }
  return sha256Fallback(new Uint8Array(buffer))
}

function makeChunkKey(sessionId, fileId, chunkIndex) {
  return `${sessionId}:${fileId}:${chunkIndex}`
}

function objectToSets(completedChunks = {}) {
  const result = {}
  for (const [fileId, indices] of Object.entries(completedChunks || {})) {
    result[fileId] = new Set(indices)
  }
  return result
}

function setsToObject(completedSets = {}) {
  const result = {}
  for (const [fileId, set] of Object.entries(completedSets)) {
    result[fileId] = Array.from(set).sort((a, b) => a - b)
  }
  return result
}

function calculateIncomingProgress(filesMeta, completedSets) {
  let done = 0
  let total = 0
  for (const fileMeta of filesMeta) {
    total += fileMeta.size
    const set = completedSets[fileMeta.file_id] || new Set()
    for (const index of set) {
      const start = index * CHUNK_SIZE
      const end = Math.min(start + CHUNK_SIZE, fileMeta.size)
      done += end - start
    }
  }
  return { done, total }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}

async function clearHistory() {
  await clearStore(SESSION_STORE)
  await clearStore(CHUNK_STORE)
  await renderHistory()
  appendLog("已清空本地历史和未完成缓存。", "info")
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        const sessions = db.createObjectStore(SESSION_STORE, { keyPath: "sessionId" })
        sessions.createIndex("status", "status", { unique: false })
        sessions.createIndex("updatedAt", "updatedAt", { unique: false })
      }
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        const chunks = db.createObjectStore(CHUNK_STORE, { keyPath: "chunkKey" })
        chunks.createIndex("sessionId", "sessionId", { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
  })
}

function runTransaction(storeName, mode, work) {
  if (!state.db) {
    return Promise.resolve(null)
  }
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(storeName, mode)
    const store = tx.objectStore(storeName)
    const result = work(store)
    tx.oncomplete = async () => resolve(await result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function getSessionRecord(sessionId) {
  return runTransaction(SESSION_STORE, "readonly", (store) => idbRequest(store.get(sessionId)))
}

async function upsertSessionRecord(record) {
  return runTransaction(SESSION_STORE, "readwrite", (store) => store.put(record))
}

async function updateSessionRecord(sessionId, patch) {
  const current = (await getSessionRecord(sessionId)) || { sessionId }
  await upsertSessionRecord({ ...current, ...patch })
}

async function listRecentSessions() {
  const sessions = (await runTransaction(SESSION_STORE, "readonly", (store) => idbRequest(store.getAll()))) || []
  return sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 30)
}

async function listSessionsByStatus(status) {
  const sessions = (await runTransaction(SESSION_STORE, "readonly", (store) => {
    const index = store.index("status")
    return idbRequest(index.getAll(status))
  })) || []
  return sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

async function putChunk(record) {
  return runTransaction(CHUNK_STORE, "readwrite", (store) => store.put(record))
}

async function getChunksBySession(sessionId, fileId) {
  const all = (await runTransaction(CHUNK_STORE, "readonly", (store) => idbRequest(store.getAll()))) || []
  return all
    .filter((item) => item.sessionId === sessionId && item.fileId === fileId)
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
}

async function buildBlobFromChunks(sessionId, fileId) {
  const chunks = await getChunksBySession(sessionId, fileId)
  return new Blob(chunks.map((item) => item.data))
}

async function clearChunksBySession(sessionId) {
  const chunks = (await runTransaction(CHUNK_STORE, "readonly", (store) => idbRequest(store.getAll()))) || []
  const targets = chunks.filter((item) => item.sessionId === sessionId)
  await runTransaction(CHUNK_STORE, "readwrite", (store) => {
    targets.forEach((item) => store.delete(item.chunkKey))
  })
}

async function clearStore(storeName) {
  return runTransaction(storeName, "readwrite", (store) => store.clear())
}

function sha256Fallback(bytes) {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
    0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
    0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
    0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
    0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
    0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
  ])
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])

  const bitLength = bytes.length * 8
  const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80

  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false)
  view.setUint32(paddedLength - 4, bitLength >>> 0, false)

  const W = new Uint32Array(64)
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      W[index] = view.getUint32(offset + index * 4, false)
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rightRotate(W[index - 15], 7) ^ rightRotate(W[index - 15], 18) ^ (W[index - 15] >>> 3)
      const s1 = rightRotate(W[index - 2], 17) ^ rightRotate(W[index - 2], 19) ^ (W[index - 2] >>> 10)
      W[index] = (W[index - 16] + s0 + W[index - 7] + s1) >>> 0
    }

    let [a, b, c, d, e, f, g, h] = H
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + sum1 + ch + K[index] + W[index]) >>> 0
      const sum0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (sum0 + maj) >>> 0

      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    H[0] = (H[0] + a) >>> 0
    H[1] = (H[1] + b) >>> 0
    H[2] = (H[2] + c) >>> 0
    H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0
    H[5] = (H[5] + f) >>> 0
    H[6] = (H[6] + g) >>> 0
    H[7] = (H[7] + h) >>> 0
  }

  return Array.from(H, (item) => item.toString(16).padStart(8, "0")).join("")
}

function rightRotate(value, amount) {
  return (value >>> amount) | (value << (32 - amount))
}

function createStoredZip(entries) {
  const encoder = new TextEncoder()
  const files = entries.map((entry) => {
    const nameBytes = encoder.encode(entry.name.replaceAll("\\", "/"))
    const crc = crc32(entry.bytes)
    return {
      nameBytes,
      data: entry.bytes,
      crc,
      compressedSize: entry.bytes.length,
      uncompressedSize: entry.bytes.length,
    }
  })

  let offset = 0
  const localParts = []
  const centralParts = []
  for (const file of files) {
    const localHeader = new Uint8Array(30 + file.nameBytes.length)
    const localView = new DataView(localHeader.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint32(14, file.crc, true)
    localView.setUint32(18, file.compressedSize, true)
    localView.setUint32(22, file.uncompressedSize, true)
    localView.setUint16(26, file.nameBytes.length, true)
    localHeader.set(file.nameBytes, 30)
    localParts.push(localHeader, file.data)

    const centralHeader = new Uint8Array(46 + file.nameBytes.length)
    const centralView = new DataView(centralHeader.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint32(16, file.crc, true)
    centralView.setUint32(20, file.compressedSize, true)
    centralView.setUint32(24, file.uncompressedSize, true)
    centralView.setUint16(28, file.nameBytes.length, true)
    centralView.setUint32(42, offset, true)
    centralHeader.set(file.nameBytes, 46)
    centralParts.push(centralHeader)
    offset += localHeader.length + file.data.length
  }

  const centralSize = centralParts.reduce((sum, item) => sum + item.length, 0)
  const endRecord = new Uint8Array(22)
  const endView = new DataView(endRecord.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, files.length, true)
  endView.setUint16(10, files.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, offset, true)
  return new Blob([...localParts, ...centralParts, endRecord], { type: "application/zip" })
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let j = 0; j < 8; j += 1) {
      value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[i] = value >>> 0
  }
  return table
})()
