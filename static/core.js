const CHUNK_SIZE = 64 * 1024
const DB_NAME = "web-transfer-db"
const DB_VERSION = 1
const SESSION_STORE = "sessions"
const CHUNK_STORE = "chunks"
const MAX_BUFFERED_AMOUNT = 4 * 1024 * 1024
const MAX_LOGS = 80
const RELAY_MAX_TRANSFER_BYTES = 64 * 1024 * 1024
const IOS_SAFARI_MAX_INCOMING_BYTES = 1536 * 1024 * 1024
const SESSION_PROGRESS_BATCH_SIZE = 32
const MOBILE_SKIP_CHECKSUM_BYTES = 128 * 1024 * 1024
const DEFAULT_ICE_SERVERS = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] },
]

export function createTransferApp(options = {}) {
  return new TransferApp(options)
}

export function collectInputFiles(fileList, { allowMultipleFiles = true } = {}) {
  const files = Array.from(fileList || []).map((file) => ({
    file,
    relativePath: file.webkitRelativePath || file.name,
  }))
  return allowMultipleFiles ? files : files.slice(0, 1)
}

export async function collectDroppedFiles(dataTransfer, { allowMultipleFiles = true } = {}) {
  const items = Array.from((dataTransfer && dataTransfer.items) || [])
  if (!items.length) {
    return collectInputFiles((dataTransfer && dataTransfer.files) || [], { allowMultipleFiles })
  }

  const allFiles = []
  for (const item of items) {
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null
    if (entry) {
      allFiles.push(...(await walkEntry(entry)))
    } else {
      const file = item.getAsFile ? item.getAsFile() : null
      if (file) {
        allFiles.push({ file, relativePath: file.name })
      }
    }
    if (!allowMultipleFiles && allFiles.length) {
      return allFiles.slice(0, 1)
    }
  }
  return allowMultipleFiles ? allFiles : allFiles.slice(0, 1)
}

export function buildViewUrl(view, formState = {}) {
  const targetPath = view === "mobile" ? "/m" : "/"
  const url = new URL(targetPath, window.location.origin)
  url.searchParams.set("view", view)
  if (formState.roomCode) {
    url.searchParams.set("room", formState.roomCode)
  }
  if (formState.displayName) {
    url.searchParams.set("name", formState.displayName)
  }
  return `${url.pathname}${url.search}`
}

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

class TransferApp {
  constructor(options) {
    this.options = {
      allowMultipleFiles: true,
      allowIncomingMultiFile: true,
      enableHistory: true,
      enableResume: true,
      ...options,
    }
    this.listeners = new Set()
    this.runtime = detectRuntimeCapabilities()
    this.transferMetrics = null
    this.incomingChunkState = new Map()
    this.state = {
      ws: null,
      db: null,
      roomCode: "",
      displayName: "",
      clientId: "",
      formRoomCode: "",
      formDisplayName: "",
      peers: new Map(),
      connections: new Map(),
      selectedPeerId: null,
      selectedFiles: [],
      pendingIncomingRequests: new Map(),
      outgoingSessions: new Map(),
      chatMessages: new Map(),
      unreadMessages: new Map(),
      history: [],
      logs: [],
      transferStatus: null,
    }
    this.restoreFormState()
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  notify() {
    for (const listener of this.listeners) {
      listener()
    }
  }

  async initialize() {
    this.restoreFormState()
    try {
      this.state.db = await openDatabase()
      await this.refreshHistory()
    } catch (error) {
      this.appendLog(`本地存储初始化失败: ${error.message}`, "warn")
    }
    if (this.runtime.isIOSWebKitBrowser) {
      this.appendLog("Large-file receive on iPhone browsers is limited. Safer limits are enabled.", "warn")
    }
    this.notify()
  }

  restoreFormState() {
    const params = new URLSearchParams(window.location.search)
    const displayName = params.get("name") || localStorage.getItem("web-transfer-display-name") || ""
    const roomCode = params.get("room") || localStorage.getItem("web-transfer-room-code") || ""
    this.state.formDisplayName = displayName
    this.state.formRoomCode = roomCode
  }

  getInitialFormState() {
    return {
      displayName: this.state.formDisplayName,
      roomCode: this.state.formRoomCode,
    }
  }

  getSelectedPeer() {
    return this.state.selectedPeerId ? this.state.peers.get(this.state.selectedPeerId) || null : null
  }

  getPeerName(peerId) {
    const peer = this.state.peers.get(peerId)
    return (peer && peer.display_name) || peerId
  }

  getConnection(peerId) {
    return this.state.connections.has(peerId) ? this.state.connections.get(peerId) : null
  }

  getOpenConnection(peerId) {
    const connection = this.getConnection(peerId)
    if (!connection || !connection.channel || connection.channel.readyState !== "open") {
      return null
    }
    return connection
  }

  getChatMessages(peerId) {
    return this.state.chatMessages.get(peerId) || []
  }

  getUnreadCount(peerId) {
    return this.state.unreadMessages.get(peerId) || 0
  }

  getCurrentOutgoingSession() {
    const sessions = Array.from(this.state.outgoingSessions.values())
    sessions.sort((left, right) => {
      const leftPriority = left.sending ? 3 : left.accepted ? 2 : 1
      const rightPriority = right.sending ? 3 : right.accepted ? 2 : 1
      if (leftPriority !== rightPriority) {
        return rightPriority - leftPriority
      }
      return (right.createdAt || 0) - (left.createdAt || 0)
    })
    return sessions[0] || null
  }

  getCurrentIncomingSession() {
    const sessions = Array.from(this.incomingChunkState.values())
    sessions.sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0))
    return sessions[0] || null
  }

  getTransferAction() {
    const outgoing = this.getCurrentOutgoingSession()
    if (outgoing && outgoing.sending) {
      return {
        type: "stop_outgoing",
        label: "停止发送",
        sessionId: outgoing.sessionId,
      }
    }

    const incoming = this.getCurrentIncomingSession()
    if (incoming) {
      return {
        type: "stop_incoming",
        label: "停止接收",
        sessionId: incoming.sessionId,
      }
    }

    if (outgoing) {
      return {
        type: "cancel_outgoing",
        label: "取消请求",
        sessionId: outgoing.sessionId,
      }
    }

    return null
  }

  isConnected() {
    return Boolean(this.state.ws && this.state.ws.readyState === WebSocket.OPEN)
  }

  setSelectedFiles(items) {
    const files = Array.from(items || [])
    this.state.selectedFiles = this.options.allowMultipleFiles ? files : files.slice(0, 1)
    this.notify()
  }

  clearSelectedFiles() {
    this.state.selectedFiles = []
    this.notify()
  }

  appendLog(message, level = "info") {
    if (!message) {
      return
    }
    this.state.logs.unshift({
      id: makeId(),
      level,
      message,
      timestamp: Date.now(),
    })
    this.state.logs = this.state.logs.slice(0, MAX_LOGS)
    this.notify()
  }

  setTransferStatus(label, done = 0, total = 0) {
    const percent = total ? Math.round((done / total) * 100) : 0
    const speed = this.measureTransferSpeed(label, done, total)
    this.state.transferStatus = {
      label,
      done,
      total,
      percent,
      speed,
    }
    this.notify()
  }

  clearTransferStatus() {
    this.transferMetrics = null
    this.state.transferStatus = null
    this.notify()
  }

  measureTransferSpeed(label, done, total) {
    const now = Date.now()
    const previous = this.transferMetrics
    const isContinuous =
      previous &&
      previous.label === label &&
      previous.total === total &&
      done >= previous.done

    if (!isContinuous) {
      this.transferMetrics = {
        label,
        total,
        startTime: now,
        lastTime: now,
        done,
        smoothedBytesPerSecond: 0,
      }
      return 0
    }

    const deltaBytes = done - previous.done
    const deltaMs = now - previous.lastTime
    let smoothedBytesPerSecond = previous.smoothedBytesPerSecond
    if (deltaBytes > 0 && deltaMs > 0) {
      const instantBytesPerSecond = (deltaBytes * 1000) / deltaMs
      smoothedBytesPerSecond = smoothedBytesPerSecond
        ? smoothedBytesPerSecond * 0.7 + instantBytesPerSecond * 0.3
        : instantBytesPerSecond
    }

    const elapsedMs = Math.max(now - previous.startTime, 1)
    const averageBytesPerSecond = done > 0 ? (done * 1000) / elapsedMs : 0
    const speed = smoothedBytesPerSecond || averageBytesPerSecond

    this.transferMetrics = {
      ...previous,
      lastTime: now,
      done,
      smoothedBytesPerSecond,
    }
    return speed
  }

  shouldAvoidRelayForSize(totalSize) {
    return totalSize > RELAY_MAX_TRANSFER_BYTES
  }

  shouldBlockIncomingTransfer(totalSize, transportPreference) {
    if (!this.runtime.isIOSWebKitBrowser) {
      return null
    }
    if (transportPreference === "relay" && totalSize > RELAY_MAX_TRANSFER_BYTES) {
      return "iPhone browsers do not support relayed large transfers reliably. Wait for direct connection or use desktop mode."
    }
    if (totalSize > IOS_SAFARI_MAX_INCOMING_BYTES) {
      return "This file is too large for reliable receive on iPhone browsers. Use desktop mode on the phone or another device."
    }
    return null
  }

  ensureIncomingChunkState(session) {
    let chunkState = this.incomingChunkState.get(session.sessionId)
    if (!chunkState) {
      chunkState = {
        sessionId: session.sessionId,
        peerClientId: session.peerClientId || "",
        filesMeta: Array.from(session.filesMeta || []),
        peerName: session.peerName || "",
        completedSets: objectToSets(session.completedChunks),
        dirtyCount: 0,
        createdAt: session.createdAt || Date.now(),
      }
      this.incomingChunkState.set(session.sessionId, chunkState)
    }
    return chunkState
  }

  async flushIncomingChunkState(sessionId, patch = {}) {
    const chunkState = this.incomingChunkState.get(sessionId)
    if (!chunkState) {
      if (Object.keys(patch).length) {
        await this.updateSessionRecord(sessionId, patch)
      }
      return
    }
    chunkState.dirtyCount = 0
    await this.updateSessionRecord(sessionId, {
      completedChunks: setsToObject(chunkState.completedSets),
      updatedAt: Date.now(),
      ...patch,
    })
  }

  clearIncomingChunkState(sessionId) {
    this.incomingChunkState.delete(sessionId)
  }

  assertSessionNotCancelled(session) {
    if (session && session.cancelRequested) {
      throw new TransferCancelledError(session.cancelReason || "The transfer was cancelled.")
    }
  }

  async finalizeOutgoingCancellation(session, reason) {
    if (!session) {
      return
    }
    session.cancelRequested = true
    session.cancelReason = reason
    await this.updateSessionRecord(session.sessionId, {
      status: "cancelled",
      updatedAt: Date.now(),
      completedAt: null,
      errorMessage: reason,
    })
    this.state.outgoingSessions.delete(session.sessionId)
    this.clearTransferStatus()
    await this.refreshHistory()
    this.notify()
  }

  shouldSkipChecksum(fileMeta) {
    return Boolean(this.runtime.isMobileBrowser && fileMeta && fileMeta.size > MOBILE_SKIP_CHECKSUM_BYTES)
  }

  async connectToRoom(roomCodeInput, displayNameInput) {
    try {
      const roomCode = String(roomCodeInput || "").trim()
      const displayName = String(displayNameInput || "").trim() || `PC-${Math.floor(Math.random() * 1000)}`
      if (!roomCode) {
        this.appendLog("请输入房间码。", "warn")
        return
      }

      this.disconnectFromRoom()
      this.state.roomCode = roomCode
      this.state.displayName = displayName
      this.state.formRoomCode = roomCode
      this.state.formDisplayName = displayName
      this.state.clientId = makeId()
      localStorage.setItem("web-transfer-display-name", displayName)
      localStorage.setItem("web-transfer-room-code", roomCode)

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws/signaling`)
      this.state.ws = socket
      this.notify()

      socket.addEventListener("open", () => {
        if (this.state.ws !== socket) {
          return
        }
        this.sendSignal({
          type: "join_room",
          room_code: roomCode,
          client_id: this.state.clientId,
          display_name: displayName,
        })
        this.appendLog(`已进入房间 ${roomCode}。`, "info")
      })

      socket.addEventListener("message", async (event) => {
        if (this.state.ws !== socket) {
          return
        }
        await this.handleSignalMessage(JSON.parse(event.data))
      })

      socket.addEventListener("error", () => {
        if (this.state.ws !== socket) {
          return
        }
        this.appendLog("信令连接失败。请确认访问的是正确 IP 和端口。", "danger")
      })

      socket.addEventListener("close", () => {
        if (this.state.ws !== socket) {
          return
        }
        this.state.ws = null
        this.appendLog("信令连接已断开。", "warn")
        this.resetRoomState()
      })
    } catch (error) {
      this.appendLog(`进入房间失败: ${error.message}`, "danger")
    }
  }

  disconnectFromRoom() {
    if (this.state.ws) {
      const socket = this.state.ws
      this.state.ws = null
      socket.close()
    }
    this.resetRoomState()
  }

  resetRoomState() {
    this.closeAllPeerConnections()
    this.incomingChunkState.clear()
    this.state.outgoingSessions.clear()
    this.state.peers.clear()
    this.state.connections.clear()
    this.state.pendingIncomingRequests.clear()
    this.state.chatMessages.clear()
    this.state.unreadMessages.clear()
    this.state.selectedPeerId = null
    this.state.clientId = ""
    this.clearTransferStatus()
    this.notify()
  }

  async handleSignalMessage(message) {
    switch (message.type) {
      case "joined_room":
        this.state.clientId = message.client_id
        for (const peer of message.peers) {
          this.upsertPeer(peer)
          await this.ensurePeerConnection(peer.client_id, this.state.clientId.localeCompare(peer.client_id) < 0)
        }
        this.pickFallbackPeer()
        await this.resumePendingSessions()
        this.notify()
        break
      case "peer_joined":
        this.upsertPeer({ client_id: message.client_id, display_name: message.display_name })
        this.appendLog(`设备 ${message.display_name} 已进入房间。`, "info")
        await this.ensurePeerConnection(message.client_id, this.state.clientId.localeCompare(message.client_id) < 0)
        this.pickFallbackPeer()
        await this.resumePendingSessions(message.client_id)
        this.notify()
        break
      case "peer_left":
        this.appendLog(`设备 ${this.getPeerName(message.client_id)} 已离开。`, "warn")
        this.removePeer(message.client_id)
        this.notify()
        break
      case "webrtc_offer":
        await this.onOffer(message)
        break
      case "webrtc_answer":
        await this.onAnswer(message)
        break
      case "ice_candidate":
        await this.onIceCandidate(message)
        break
      case "transfer_request":
        await this.onTransferRequest(message)
        break
      case "transfer_accept":
        await this.onTransferAccept(message)
        break
      case "transfer_reject":
        await this.onTransferReject(message)
        break
      case "transfer_cancel":
        await this.onTransferCancel(message)
        break
      case "transfer_abort":
        await this.onTransferAbort(message)
        break
      case "relay_payload":
        await this.onRelayPayload(message)
        break
      case "resume_request":
        await this.onResumeRequest(message)
        break
      case "resume_state":
        await this.onResumeState(message)
        break
      case "error":
        this.appendLog(message.message, "danger")
        break
      default:
        this.appendLog(`忽略未知信令消息 ${message.type}。`, "warn")
    }
  }

  upsertPeer(peer) {
    if (!peer || !peer.client_id || peer.client_id === this.state.clientId) {
      return
    }
    this.state.peers.set(peer.client_id, {
      client_id: peer.client_id,
      display_name: peer.display_name || peer.client_id,
    })
  }

  removePeer(peerId) {
    this.state.peers.delete(peerId)
    this.closePeerConnection(peerId)
    for (const request of this.state.pendingIncomingRequests.values()) {
      if (request.fromClientId === peerId) {
        this.state.pendingIncomingRequests.delete(request.sessionId)
      }
    }
    if (this.state.selectedPeerId === peerId) {
      this.state.selectedPeerId = null
      this.pickFallbackPeer()
    }
  }

  pickFallbackPeer() {
    if (this.state.selectedPeerId && this.state.peers.has(this.state.selectedPeerId)) {
      return
    }
    const nextPeerCandidate = this.state.peers.keys().next().value
    this.state.selectedPeerId = nextPeerCandidate === undefined ? null : nextPeerCandidate
  }

  selectPeer(peerId) {
    if (!this.state.peers.has(peerId)) {
      return
    }
    this.state.selectedPeerId = peerId
    this.state.unreadMessages.set(peerId, 0)
    this.notify()
  }

  async ensurePeerConnection(peerId, initiator) {
    if (!this.state.peers.has(peerId)) {
      return null
    }
    let connection = this.state.connections.get(peerId)
    if (connection) {
      return connection
    }

    const pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS })
    connection = {
      peerId,
      pc,
      channel: null,
      expectedChunkHeader: null,
      pendingIceCandidates: [],
      connectionState: "new",
      channelState: "idle",
      sendingSessionId: null,
    }
    this.state.connections.set(peerId, connection)

    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        this.appendLog(`${this.getPeerName(peerId)} ICE 候选收集完成。`, "info")
        this.sendSignal({
          type: "ice_candidate",
          target_client_id: peerId,
          candidate: null,
        })
        return
      }
      this.appendLog(`${this.getPeerName(peerId)} 生成 ICE 候选。`, "info")
      this.sendSignal({
        type: "ice_candidate",
        target_client_id: peerId,
        candidate: serializeIceCandidate(event.candidate),
      })
    }

    pc.onconnectionstatechange = () => {
      connection.connectionState = pc.connectionState || "new"
      this.appendLog(`${this.getPeerName(peerId)} 连接状态: ${connection.connectionState}`, connection.connectionState === "failed" ? "warn" : "info")
      this.notify()
    }

    pc.oniceconnectionstatechange = () => {
      this.appendLog(`${this.getPeerName(peerId)} ICE 状态: ${pc.iceConnectionState || "new"}`, ["failed", "disconnected", "closed"].includes(pc.iceConnectionState || "") ? "warn" : "info")
      this.notify()
    }

    pc.onicegatheringstatechange = () => {
      this.appendLog(`${this.getPeerName(peerId)} ICE 收集中: ${pc.iceGatheringState || "new"}`, "info")
      this.notify()
    }

    pc.onsignalingstatechange = () => {
      this.appendLog(`${this.getPeerName(peerId)} 信令状态: ${pc.signalingState || "stable"}`, "info")
      this.notify()
    }

    pc.ondatachannel = (event) => {
      this.attachDataChannel(peerId, event.channel)
    }

    if (initiator) {
      this.attachDataChannel(peerId, pc.createDataChannel("file-transfer", { ordered: true }))
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      this.appendLog(`已向 ${this.getPeerName(peerId)} 发送 WebRTC offer。`, "info")
      this.sendSignal({
        type: "webrtc_offer",
        target_client_id: peerId,
        sdp: offer,
      })
    }

    this.notify()
    return connection
  }

  async onOffer(message) {
    const connection = await this.ensurePeerConnection(message.from_client_id, false)
    this.appendLog(`收到 ${this.getPeerName(message.from_client_id)} 的 WebRTC offer。`, "info")
    await connection.pc.setRemoteDescription(message.sdp)
    await this.flushPendingIceCandidates(connection)
    const answer = await connection.pc.createAnswer()
    await connection.pc.setLocalDescription(answer)
    this.appendLog(`已向 ${this.getPeerName(message.from_client_id)} 发送 WebRTC answer。`, "info")
    this.sendSignal({
      type: "webrtc_answer",
      target_client_id: message.from_client_id,
      sdp: answer,
    })
  }

  async onAnswer(message) {
    const connection = this.state.connections.get(message.from_client_id)
    if (!connection) {
      return
    }
    this.appendLog(`收到 ${this.getPeerName(message.from_client_id)} 的 WebRTC answer。`, "info")
    await connection.pc.setRemoteDescription(message.sdp)
    await this.flushPendingIceCandidates(connection)
  }

  async onIceCandidate(message) {
    const connection = this.state.connections.get(message.from_client_id)
    if (!connection) {
      return
    }
    if (message.candidate == null) {
      if (!connection.pc.remoteDescription) {
        connection.pendingIceCandidates.push(null)
        return
      }
      try {
        await connection.pc.addIceCandidate(null)
        this.appendLog(`已标记 ${this.getPeerName(message.from_client_id)} 的 ICE 候选结束。`, "info")
      } catch (error) {
        this.appendLog(`ICE 结束标记处理失败: ${error.message}`, "warn")
      }
      return
    }
    if (!connection.pc.remoteDescription) {
      this.appendLog(`${this.getPeerName(message.from_client_id)} 的 ICE 候选已排队，等待远端描述。`, "info")
      connection.pendingIceCandidates.push(message.candidate)
      return
    }
    try {
      await connection.pc.addIceCandidate(deserializeIceCandidate(message.candidate))
      this.appendLog(`已应用 ${this.getPeerName(message.from_client_id)} 的 ICE 候选。`, "info")
    } catch (error) {
      this.appendLog(`ICE 候选处理失败: ${error.message}`, "warn")
    }
  }

  async flushPendingIceCandidates(connection) {
    if (!connection || !connection.pendingIceCandidates.length || !connection.pc.remoteDescription) {
      return
    }
    const queued = connection.pendingIceCandidates.splice(0, connection.pendingIceCandidates.length)
    for (const candidate of queued) {
      try {
        await connection.pc.addIceCandidate(candidate == null ? null : deserializeIceCandidate(candidate))
        this.appendLog(
          candidate == null
            ? `已补充标记 ${this.getPeerName(connection.peerId)} 的 ICE 候选结束。`
            : `已补充应用 ${this.getPeerName(connection.peerId)} 的 ICE 候选。`,
          "info"
        )
      } catch (error) {
        this.appendLog(`补充 ICE 候选失败: ${error.message}`, "warn")
      }
    }
  }

  attachDataChannel(peerId, channel) {
    const connection = this.state.connections.get(peerId)
    if (!connection) {
      return
    }

    connection.channel = channel
    connection.channelState = channel.readyState
    channel.binaryType = "arraybuffer"
    this.appendLog(`${this.getPeerName(peerId)} 的 DataChannel 已创建: ${channel.label}。`, "info")

    channel.onopen = async () => {
      connection.channelState = "open"
      this.appendLog(`${this.getPeerName(peerId)} 的传输通道已打开。`, "info")
      await this.resumePendingSessions(peerId)
    }

    channel.onclose = () => {
      connection.channelState = "closed"
      connection.sendingSessionId = null
      this.appendLog(`${this.getPeerName(peerId)} 的传输通道已关闭。`, "warn")
    }

    channel.onerror = () => {
      connection.channelState = "error"
      this.notify()
    }

    channel.onmessage = async (event) => {
      await this.handleChannelMessage(peerId, event.data)
    }

    this.notify()
  }

  closePeerConnection(peerId) {
    const connection = this.state.connections.get(peerId)
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
      connection.pc.close()
    } catch (error) {
      void error
    }
    this.state.connections.delete(peerId)
  }

  closeAllPeerConnections() {
    for (const peerId of Array.from(this.state.connections.keys())) {
      this.closePeerConnection(peerId)
    }
  }

  pushChatMessage(peerId, message) {
    const existing = this.getChatMessages(peerId)
    this.state.chatMessages.set(peerId, existing.concat(message).slice(-200))
  }

  async sendChatMessage(textInput) {
    const peerId = this.state.selectedPeerId
    if (!peerId) {
      this.appendLog("先选择一台设备，再发送消息。", "warn")
      return false
    }

    const text = String(textInput || "").trim()
    if (!text) {
      return false
    }

    const timestamp = Date.now()
    const connection = this.getOpenConnection(peerId)
    if (connection) {
      this.sendDataControl(connection.channel, {
        type: "chat_message",
        message_id: makeId(),
        text,
        sent_at: timestamp,
      })
    } else if (this.isConnected()) {
      this.sendRelayPayload(peerId, {
        type: "chat_message",
        message_id: makeId(),
        text,
        sent_at: timestamp,
      })
      this.appendLog(`已通过中继发送消息到 ${this.getPeerName(peerId)}。`, "info")
    } else {
      this.appendLog("目标设备的消息通道尚未就绪。", "warn")
      return false
    }

    this.pushChatMessage(peerId, {
      id: makeId(),
      direction: "outgoing",
      peerName: this.getPeerName(peerId),
      text,
      timestamp,
    })
    this.notify()
    return true
  }

  async startTransferRequest() {
    try {
      const peerId = this.state.selectedPeerId
      if (!peerId) {
        this.appendLog("先在房间设备列表里选择一个发送对象。", "warn")
        return false
      }
      if (!this.state.selectedFiles.length) {
        this.appendLog("先选择要发送的文件。", "warn")
        return false
      }
      if (!this.options.allowMultipleFiles && this.state.selectedFiles.length > 1) {
        this.appendLog("当前界面只支持发送单个文件。", "warn")
        return false
      }
      const connection = this.getOpenConnection(peerId)
      const transportPreference = connection ? "p2p" : "relay"
      if (!connection && this.state.selectedFiles.length > 1) {
        this.appendLog("当前连接不可用时，仅支持通过中继发送单个文件。", "warn")
        return false
      }
      if (!connection) {
        this.appendLog(`将通过中继向 ${this.getPeerName(peerId)} 发送文件。`, "info")
      }

      this.setTransferStatus("准备中", 0, 0)

      const files = []
      let totalSize = 0
      for (const item of this.state.selectedFiles) {
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
      if (transportPreference === "relay" && this.shouldAvoidRelayForSize(totalSize)) {
        this.appendLog(
          `Relay mode is limited to ${formatBytes(RELAY_MAX_TRANSFER_BYTES)}. Wait for direct connection before sending ${formatBytes(totalSize)}.`,
          "warn"
        )
        return false
      }

      const sessionId = makeId()
      const createdAt = Date.now()
      const session = {
        sessionId,
        peerClientId: peerId,
        peerName: this.getPeerName(peerId),
        files,
        totalSize,
        sentBytes: 0,
        sending: false,
        accepted: false,
        transport: transportPreference,
        createdAt,
        cancelRequested: false,
        cancelReason: "",
      }
      this.state.outgoingSessions.set(sessionId, session)

      await this.upsertSessionRecord({
        sessionId,
        direction: "outgoing",
        status: "waiting",
        roomCode: this.state.roomCode,
        peerClientId: peerId,
        peerName: session.peerName,
        createdAt,
        updatedAt: Date.now(),
        completedAt: null,
        fileCount: files.length,
        totalSize,
        filesMeta: files.map(stripFileHandle),
        completedChunks: {},
      })

      this.sendSignal({
        type: "transfer_request",
        target_client_id: peerId,
        session_id: sessionId,
        total_size: totalSize,
        files: files.map(stripFileHandle),
        transport_preference: transportPreference,
      })

      this.appendLog(`已向 ${session.peerName} 发起传输请求。`, "info")
      await this.refreshHistory()
      return true
    } catch (error) {
      this.appendLog(`准备传输失败: ${error.message}`, "danger")
      return false
    } finally {
      if (!this.state.transferStatus || this.state.transferStatus.label === "准备中") {
        this.clearTransferStatus()
      }
    }
  }

  async onTransferRequest(message) {
    const incomingFiles = Array.from(message.files || [])
    const isSingleTopLevelFile =
      incomingFiles.length === 1 && !String(incomingFiles[0].relative_path || "").includes("/")

    if (!this.options.allowIncomingMultiFile && !isSingleTopLevelFile) {
      this.appendLog("手机端当前仅支持接收单文件，请切换桌面版接收。", "warn")
      this.sendSignal({
        type: "transfer_reject",
        target_client_id: message.from_client_id,
        session_id: message.session_id,
        reason: "This device only accepts a single top-level file in the current view.",
      })
      await this.upsertSessionRecord({
        sessionId: message.session_id,
        direction: "incoming",
        status: "rejected",
        roomCode: this.state.roomCode,
        peerClientId: message.from_client_id,
        peerName: this.getPeerName(message.from_client_id),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        completedAt: null,
        fileCount: incomingFiles.length,
        totalSize: message.total_size,
        filesMeta: incomingFiles,
        completedChunks: {},
      })
      await this.refreshHistory()
      return
    }

    const peerName = this.getPeerName(message.from_client_id)
    const existing = await this.getSessionRecord(message.session_id)
    const blockReason = this.shouldBlockIncomingTransfer(
      Number(message.total_size) || 0,
      message.transport_preference || "p2p"
    )
    if (blockReason) {
      this.appendLog(blockReason, "warn")
      this.sendSignal({
        type: "transfer_reject",
        target_client_id: message.from_client_id,
        session_id: message.session_id,
        reason: blockReason,
      })
      await this.upsertSessionRecord({
        sessionId: message.session_id,
        direction: "incoming",
        status: "rejected",
        roomCode: this.state.roomCode,
        peerClientId: message.from_client_id,
        peerName,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        completedAt: null,
        fileCount: incomingFiles.length,
        totalSize: message.total_size,
        filesMeta: incomingFiles,
        completedChunks: {},
      })
      await this.refreshHistory()
      return
    }
    this.state.pendingIncomingRequests.set(message.session_id, {
      sessionId: message.session_id,
      fromClientId: message.from_client_id,
      peerName,
      files: incomingFiles,
      totalSize: message.total_size,
      isResume: existing && existing.status === "pending",
      transportPreference: message.transport_preference || "p2p",
    })
    this.appendLog(`${peerName} 请求发送 ${incomingFiles.length} 个项目。`, "info")
    this.notify()
  }

  async acceptIncomingTransfer(sessionId) {
    const request = this.state.pendingIncomingRequests.get(sessionId)
    if (!request) {
      return
    }
    const transport =
      request.transportPreference === "relay" || !this.getOpenConnection(request.fromClientId) ? "relay" : "p2p"

    let session = await this.getSessionRecord(sessionId)
    if (!session) {
      session = {
        sessionId,
        direction: "incoming",
        status: "pending",
        roomCode: this.state.roomCode,
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

    await this.upsertSessionRecord(session)
    this.ensureIncomingChunkState(session)
    this.sendSignal({
      type: "transfer_accept",
      target_client_id: request.fromClientId,
      session_id: sessionId,
      transport,
    })
    if (transport === "p2p") {
      this.sendSignal({
        type: "resume_state",
        target_client_id: request.fromClientId,
        session_id: sessionId,
        files: request.files.map((file) => ({
          file_id: file.file_id,
          completed_chunks: ((session.completedChunks && session.completedChunks[file.file_id]) || []).slice(),
        })),
      })
    }

    this.state.pendingIncomingRequests.delete(sessionId)
    this.appendLog(`已接受 ${request.peerName} 的传输请求（${transport === "relay" ? "中继" : "直连"}）。`, "info")
    await this.refreshHistory()
    this.notify()
  }

  async rejectIncomingTransfer(sessionId) {
    const request = this.state.pendingIncomingRequests.get(sessionId)
    if (!request) {
      return
    }

    this.sendSignal({
      type: "transfer_reject",
      target_client_id: request.fromClientId,
      session_id: sessionId,
      reason: "The receiver rejected the transfer.",
    })
    await this.upsertSessionRecord({
      sessionId,
      direction: "incoming",
      status: "rejected",
      roomCode: this.state.roomCode,
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

    this.state.pendingIncomingRequests.delete(sessionId)
    this.clearIncomingChunkState(sessionId)
    await this.refreshHistory()
    this.notify()
  }

  async cancelOutgoingSession(sessionId, reason = "The sender cancelled the transfer.") {
    const session = this.state.outgoingSessions.get(sessionId)
    if (!session) {
      return false
    }

    if (session.accepted || session.sending) {
      session.cancelRequested = true
      session.cancelReason = reason
      if (this.isConnected()) {
        this.sendSignal({
          type: "transfer_abort",
          target_client_id: session.peerClientId,
          session_id: sessionId,
          reason,
        })
      }
      this.appendLog(
        session.sending ? `Stopping transfer to ${session.peerName}.` : `Cancelled transfer to ${session.peerName}.`,
        "warn"
      )
      if (!session.sending) {
        await this.finalizeOutgoingCancellation(session, reason)
      }
      this.notify()
      return true
    }

    if (this.isConnected()) {
      this.sendSignal({
        type: "transfer_cancel",
        target_client_id: session.peerClientId,
        session_id: sessionId,
        reason,
      })
    }
    await this.finalizeOutgoingCancellation(session, reason)
    return true
  }

  async cancelIncomingSession(sessionId, reason = "The receiver cancelled the transfer.", notifyPeer = false) {
    const request = this.state.pendingIncomingRequests.get(sessionId) || null
    const chunkState = this.incomingChunkState.get(sessionId) || null
    const session = await this.getSessionRecord(sessionId)
    if (session && ["completed", "rejected", "cancelled"].includes(session.status)) {
      return false
    }
    const peerClientId = request?.fromClientId || chunkState?.peerClientId || session?.peerClientId || null
    const peerName = request?.peerName || chunkState?.peerName || session?.peerName || ""

    if (notifyPeer && peerClientId && this.isConnected()) {
      this.sendSignal({
        type: "transfer_abort",
        target_client_id: peerClientId,
        session_id: sessionId,
        reason,
      })
    }

    this.state.pendingIncomingRequests.delete(sessionId)
    await this.clearChunksBySession(sessionId)
    this.clearIncomingChunkState(sessionId)

    if (session) {
      await this.updateSessionRecord(sessionId, {
        status: "cancelled",
        updatedAt: Date.now(),
        completedAt: null,
        errorMessage: reason,
      })
    } else if (request) {
      await this.upsertSessionRecord({
        sessionId,
        direction: "incoming",
        status: "cancelled",
        roomCode: this.state.roomCode,
        peerClientId: request.fromClientId,
        peerName: request.peerName,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        completedAt: null,
        fileCount: request.files.length,
        totalSize: request.totalSize,
        filesMeta: request.files,
        completedChunks: {},
        errorMessage: reason,
      })
    }

    if (peerName) {
      this.appendLog(`${peerName} transfer cancelled.`, "warn")
    }
    this.clearTransferStatus()
    await this.refreshHistory()
    this.notify()
    return true
  }

  async performTransferAction() {
    const action = this.getTransferAction()
    if (!action) {
      return false
    }
    if (action.type === "cancel_outgoing" || action.type === "stop_outgoing") {
      return this.cancelOutgoingSession(action.sessionId)
    }
    if (action.type === "stop_incoming") {
      return this.cancelIncomingSession(action.sessionId, "The receiver cancelled the transfer.", true)
    }
    return false
  }

  async onTransferAccept(message) {
    const session = this.state.outgoingSessions.get(message.session_id)
    if (!session) {
      return
    }
    session.accepted = true
    session.transport = message.transport || session.transport || "p2p"
    this.appendLog(`${session.peerName} 已确认接收（${session.transport === "relay" ? "中继" : "直连"}）。`, "info")
    await this.updateSessionRecord(message.session_id, {
      status: "accepted",
      updatedAt: Date.now(),
    })
    await this.refreshHistory()
    if (session.transport === "relay") {
      await this.sendOutgoingSession(session, new Map())
    }
  }

  async onTransferReject(message) {
    const session = this.state.outgoingSessions.get(message.session_id)
    if (!session) {
      return
    }
    const reason = String(message.reason || "").trim()
    if (reason) {
      this.appendLog(`${session.peerName} rejected the transfer: ${reason}`, "warn")
      await this.updateSessionRecord(message.session_id, {
        status: "rejected",
        updatedAt: Date.now(),
        errorMessage: reason,
      })
      this.state.outgoingSessions.delete(message.session_id)
      await this.refreshHistory()
      return
    }
    this.appendLog(`${session.peerName} 已拒绝接收。`, "warn")
    await this.updateSessionRecord(message.session_id, {
      status: "rejected",
      updatedAt: Date.now(),
      errorMessage: null,
    })
    this.state.outgoingSessions.delete(message.session_id)
    await this.refreshHistory()
  }

  async onTransferCancel(message) {
    const reason = String(message.reason || "").trim() || "The sender cancelled the transfer."
    const outgoingSession = this.state.outgoingSessions.get(message.session_id)
    if (outgoingSession) {
      await this.finalizeOutgoingCancellation(outgoingSession, reason)
      return
    }

    if (
      this.state.pendingIncomingRequests.has(message.session_id) ||
      this.incomingChunkState.has(message.session_id) ||
      (await this.getSessionRecord(message.session_id))
    ) {
      await this.cancelIncomingSession(message.session_id, reason, false)
    }
  }

  async onTransferAbort(message) {
    const reason = String(message.reason || "").trim() || "The other side stopped the transfer."
    const outgoingSession = this.state.outgoingSessions.get(message.session_id)
    if (outgoingSession) {
      outgoingSession.cancelRequested = true
      outgoingSession.cancelReason = reason
      this.appendLog(reason, "warn")
      if (!outgoingSession.sending) {
        await this.finalizeOutgoingCancellation(outgoingSession, reason)
      }
      return
    }

    await this.cancelIncomingSession(message.session_id, reason, false)
  }

  async onResumeRequest(message) {
    const session = this.state.outgoingSessions.get(message.session_id)
    if (!session) {
      this.appendLog(`恢复请求找不到发送会话 ${message.session_id}。`, "warn")
      return
    }
    this.sendSignal({
      type: "transfer_request",
      target_client_id: message.from_client_id,
      session_id: session.sessionId,
      total_size: session.totalSize,
      files: session.files.map(stripFileHandle),
    })
  }

  async onResumeState(message) {
    const session = this.state.outgoingSessions.get(message.session_id)
    if (!session) {
      return
    }
    const completedMap = new Map()
    for (const fileState of message.files || []) {
      completedMap.set(fileState.file_id, new Set(fileState.completed_chunks || []))
    }
    await this.sendOutgoingSession(session, completedMap)
  }

  async sendOutgoingSession(session, completedMap) {
    if (session.sending) {
      return
    }
    const transport = session.transport || "p2p"
    const connection = transport === "p2p" ? this.getOpenConnection(session.peerClientId) : null
    if (transport === "p2p" && !connection) {
      throw new Error(`设备 ${session.peerName} 的传输通道未就绪。`)
    }
    if (connection && connection.sendingSessionId && connection.sendingSessionId !== session.sessionId) {
      this.appendLog(`${session.peerName} 当前已有其他传输进行中。`, "warn")
      return
    }

    session.sending = true
    session.sentBytes = 0
    if (connection) {
      connection.sendingSessionId = session.sessionId
    }

    try {
      if (transport === "p2p") {
        await waitForChannelOpen(connection)
      }
      this.assertSessionNotCancelled(session)
      await this.updateSessionRecord(session.sessionId, {
        status: "sending",
        updatedAt: Date.now(),
      })
      this.setTransferStatus(`${transport === "relay" ? "中继发送到" : "发送到"} ${session.peerName}`, session.sentBytes, session.totalSize)

      await this.sendTransferControl(session.peerClientId, transport, connection, {
        type: "session_start",
        session_id: session.sessionId,
        total_size: session.totalSize,
        file_count: session.files.length,
      })

      for (const fileMeta of session.files) {
        this.assertSessionNotCancelled(session)
        const completedChunks = completedMap.has(fileMeta.file_id) ? completedMap.get(fileMeta.file_id) : new Set()
        await this.sendTransferControl(session.peerClientId, transport, connection, {
          type: "file_start",
          session_id: session.sessionId,
          file_id: fileMeta.file_id,
          relative_path: fileMeta.relative_path,
          size: fileMeta.size,
          chunk_count: fileMeta.chunk_count,
          sha256: fileMeta.sha256,
        })

        for (let chunkIndex = 0; chunkIndex < fileMeta.chunk_count; chunkIndex += 1) {
          this.assertSessionNotCancelled(session)
          const chunkSize = Math.min(CHUNK_SIZE, Math.max(fileMeta.size - chunkIndex * CHUNK_SIZE, 0))
          if (completedChunks.has(chunkIndex)) {
            session.sentBytes += chunkSize
            this.setTransferStatus(`发送到 ${session.peerName}`, session.sentBytes, session.totalSize)
            continue
          }

          const start = chunkIndex * CHUNK_SIZE
          const end = Math.min(start + CHUNK_SIZE, fileMeta.size)
          const buffer = await fileMeta.file.slice(start, end).arrayBuffer()
          this.assertSessionNotCancelled(session)
          const header = {
            type: "chunk",
            session_id: session.sessionId,
            file_id: fileMeta.file_id,
            chunk_index: chunkIndex,
            size: buffer.byteLength,
          }
          if (transport === "p2p") {
            this.sendDataControl(connection.channel, header)
            await waitForBufferedAmount(connection.channel, buffer.byteLength)
            this.assertSessionNotCancelled(session)
            connection.channel.send(buffer)
          } else {
            this.sendRelayPayload(session.peerClientId, {
              relay_type: "control",
              payload: header,
            })
            this.sendRelayPayload(session.peerClientId, {
              relay_type: "binary",
              header,
              data_b64: arrayBufferToBase64(buffer),
            })
          }
          session.sentBytes += buffer.byteLength
          this.setTransferStatus(`${transport === "relay" ? "中继发送到" : "发送到"} ${session.peerName}`, session.sentBytes, session.totalSize)
        }

        await this.sendTransferControl(session.peerClientId, transport, connection, {
          type: "file_end",
          session_id: session.sessionId,
          file_id: fileMeta.file_id,
          sha256: fileMeta.sha256,
        })
      }

      await this.sendTransferControl(session.peerClientId, transport, connection, {
        type: "session_complete",
        session_id: session.sessionId,
      })

      this.appendLog(`发送完成: ${session.peerName}。`, "info")
      await this.updateSessionRecord(session.sessionId, {
        status: "completed",
        updatedAt: Date.now(),
        completedAt: Date.now(),
      })
      this.state.outgoingSessions.delete(session.sessionId)
      await this.refreshHistory()
    } catch (error) {
      if (error instanceof TransferCancelledError) {
        await this.finalizeOutgoingCancellation(session, error.message)
        return
      }
      this.appendLog(`发送中断: ${error.message}`, "danger")
      await this.updateSessionRecord(session.sessionId, {
        status: "pending",
        updatedAt: Date.now(),
      })
      await this.refreshHistory()
    } finally {
      session.sending = false
      if (connection) {
        connection.sendingSessionId = null
      }
      this.clearTransferStatus()
    }
  }

  async sendTransferControl(peerId, transport, connection, payload) {
    if (transport === "p2p") {
      this.sendDataControl(connection.channel, payload)
      return
    }
    this.sendRelayPayload(peerId, {
      relay_type: "control",
      payload,
    })
  }

  async handleChannelMessage(peerId, payload) {
    const connection = this.getConnection(peerId)
    if (!connection) {
      return
    }

    if (typeof payload === "string") {
      const message = JSON.parse(payload)
      switch (message.type) {
        case "session_start":
          this.appendLog(`开始接收 ${this.getPeerName(peerId)} 的会话 ${message.session_id}。`, "info")
          break
        case "chat_message":
          this.onChatMessage(peerId, message)
          break
        case "file_start":
          this.appendLog(`开始接收 ${message.relative_path}。`, "info")
          break
        case "chunk":
          connection.expectedChunkHeader = message
          break
        case "file_end":
          await this.finalizeIncomingFile(message)
          break
        case "session_complete":
          await this.finalizeIncomingSession(message.session_id)
          break
        default:
          this.appendLog(`忽略未知数据通道消息 ${message.type}。`, "warn")
      }
      return
    }

    if (!connection.expectedChunkHeader) {
      this.appendLog("收到未匹配头信息的二进制数据。", "warn")
      return
    }

    const header = connection.expectedChunkHeader
    connection.expectedChunkHeader = null
    await this.storeIncomingChunk(header, payload)
  }

  async onRelayPayload(message) {
    const peerId = message.from_client_id
    const relayMessage = message.payload
    if (!relayMessage) {
      return
    }
    let connection = this.getConnection(peerId)
    if (!connection) {
      await this.ensurePeerConnection(peerId, false)
      connection = this.getConnection(peerId)
    }
    if (!connection) {
      return
    }

    if (relayMessage.relay_type === "binary") {
      const header = relayMessage.header || connection.expectedChunkHeader
      if (!header) {
        this.appendLog("收到未匹配头信息的中继二进制数据。", "warn")
        return
      }
      connection.expectedChunkHeader = null
      await this.storeIncomingChunk(header, base64ToArrayBuffer(relayMessage.data_b64 || ""))
      return
    }

    if (relayMessage.relay_type === "control" && relayMessage.payload) {
      const payload = relayMessage.payload
      if (payload.type === "chunk") {
        connection.expectedChunkHeader = payload
        return
      }
      await this.handleControlMessage(peerId, payload)
      return
    }

    await this.handleControlMessage(peerId, relayMessage)
  }

  async handleControlMessage(peerId, message) {
    switch (message.type) {
      case "session_start":
        this.appendLog(`开始接收 ${this.getPeerName(peerId)} 的会话 ${message.session_id}。`, "info")
        break
      case "chat_message":
        this.onChatMessage(peerId, message)
        break
      case "file_start":
        this.appendLog(`开始接收 ${message.relative_path}。`, "info")
        break
      case "chunk":
        {
          const connection = this.getConnection(peerId)
          if (connection) {
            connection.expectedChunkHeader = message
          }
        }
        break
      case "file_end":
        await this.finalizeIncomingFile(message)
        break
      case "session_complete":
        await this.finalizeIncomingSession(message.session_id)
        break
      default:
        this.appendLog(`忽略未知控制消息 ${message.type}。`, "warn")
    }
  }

  onChatMessage(peerId, message) {
    this.pushChatMessage(peerId, {
      id: message.message_id || makeId(),
      direction: "incoming",
      peerName: this.getPeerName(peerId),
      text: message.text || "",
      timestamp: Number(message.sent_at) || Date.now(),
    })
    if (this.state.selectedPeerId !== peerId) {
      this.state.unreadMessages.set(peerId, this.getUnreadCount(peerId) + 1)
      this.appendLog(`${this.getPeerName(peerId)} 发来了一条新消息。`, "info")
      return
    }
    this.notify()
  }

  async storeIncomingChunk(header, buffer) {
    const session = await this.getSessionRecord(header.session_id)
    if (!session) {
      return
    }

    const chunkState = this.ensureIncomingChunkState(session)
    const completed = chunkState.completedSets
    const fileSet = completed[header.file_id] || new Set()
    if (fileSet.has(header.chunk_index)) {
      return
    }

    await this.putChunk({
      chunkKey: makeChunkKey(header.session_id, header.file_id, header.chunk_index),
      sessionId: header.session_id,
      fileId: header.file_id,
      chunkIndex: header.chunk_index,
      data: buffer,
    })

    fileSet.add(header.chunk_index)
    completed[header.file_id] = fileSet
    await this.updateSessionRecord(header.session_id, {
      status: "pending",
      updatedAt: Date.now(),
      completedChunks: setsToObject(completed),
    })

    const progress = calculateIncomingProgress(chunkState.filesMeta, completed)
    this.setTransferStatus(`Receiving from ${chunkState.peerName || session.peerName}`, progress.done, progress.total)
    return
  }

  async finalizeIncomingFile(message) {
    await this.flushIncomingChunkState(message.session_id, { status: "pending" })
    const session = await this.getSessionRecord(message.session_id)
    if (!session) {
      return
    }
    const fileMeta = session.filesMeta.find((item) => item.file_id === message.file_id)
    if (!fileMeta) {
      return
    }

    if (this.shouldSkipChecksum(fileMeta)) {
      this.appendLog(`Skipping full checksum on mobile for large file: ${fileMeta.relative_path}`, "warn")
      return
    }

    const blob = await this.buildBlobFromChunks(message.session_id, fileMeta.file_id)
    const checksum = await hashBlob(blob)
    if (checksum !== fileMeta.sha256) {
      this.appendLog(`文件校验失败: ${fileMeta.relative_path}`, "danger")
      await this.flushIncomingChunkState(message.session_id, {
        status: "failed",
        completedAt: null,
      })
      this.clearIncomingChunkState(message.session_id)
      await this.refreshHistory()
      return
    }
    this.appendLog(`文件校验通过: ${fileMeta.relative_path}`, "info")
  }

  async finalizeIncomingSession(sessionId) {
    await this.flushIncomingChunkState(sessionId, { status: "pending" })
    const session = await this.getSessionRecord(sessionId)
    if (!session) {
      return
    }
    if (session.status === "failed") {
      this.appendLog(`会话 ${sessionId.slice(0, 8)} 校验失败，已停止保存。`, "danger")
      return
    }

    try {
      if (session.filesMeta.length === 1 && !session.filesMeta[0].relative_path.includes("/")) {
        const fileMeta = session.filesMeta[0]
        const blob = await this.buildBlobFromChunks(sessionId, fileMeta.file_id)
        downloadBlob(blob, fileMeta.relative_path)
      } else if (this.options.allowIncomingMultiFile) {
        const files = []
        for (const fileMeta of session.filesMeta) {
          const blob = await this.buildBlobFromChunks(sessionId, fileMeta.file_id)
          files.push({
            name: fileMeta.relative_path,
            bytes: new Uint8Array(await blob.arrayBuffer()),
          })
        }
        downloadBlob(createStoredZip(files), `transfer-${sessionId.slice(0, 8)}.zip`)
      } else {
        throw new Error("当前界面只支持接收单文件。")
      }
    } catch (error) {
      this.appendLog(`接收完成但保存失败: ${error.message}`, "danger")
      return
    }

    await this.flushIncomingChunkState(sessionId, {
      status: "completed",
      completedAt: Date.now(),
    })
    await this.clearChunksBySession(sessionId)
    this.clearIncomingChunkState(sessionId)
    this.appendLog(`接收完成，已保存来自 ${session.peerName} 的文件。`, "info")
    this.clearTransferStatus()
    await this.refreshHistory()
  }

  async resumePendingSessions(targetPeerId = null) {
    if (!this.options.enableResume || !this.isConnected()) {
      return
    }
    const pendingSessions = await this.listSessionsByStatus("pending")
    for (const session of pendingSessions) {
      if (session.direction !== "incoming" || session.roomCode !== this.state.roomCode) {
        continue
      }
      if (targetPeerId && session.peerClientId !== targetPeerId) {
        continue
      }
      if (!this.state.peers.has(session.peerClientId)) {
        continue
      }
      this.sendSignal({
        type: "resume_request",
        target_client_id: session.peerClientId,
        session_id: session.sessionId,
      })
    }
  }

  sendSignal(payload) {
    if (!this.state.ws || this.state.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket 未连接。")
    }
    this.state.ws.send(JSON.stringify(payload))
  }

  sendRelayPayload(peerId, payload) {
    this.sendSignal({
      type: "relay_payload",
      target_client_id: peerId,
      payload,
    })
  }

  sendDataControl(channel, payload) {
    if (!channel || channel.readyState !== "open") {
      throw new Error("DataChannel 未打开。")
    }
    channel.send(JSON.stringify(payload))
  }

  async clearHistory() {
    await this.clearStore(SESSION_STORE)
    await this.clearStore(CHUNK_STORE)
    await this.refreshHistory()
    this.appendLog("已清空本地历史和未完成缓存。", "info")
  }

  async refreshHistory() {
    if (!this.options.enableHistory || !this.state.db) {
      this.state.history = []
      this.notify()
      return
    }
    this.state.history = await this.listRecentSessions()
    this.notify()
  }

  async getSessionRecord(sessionId) {
    return this.runTransaction(SESSION_STORE, "readonly", (store) => idbRequest(store.get(sessionId)))
  }

  async upsertSessionRecord(record) {
    return this.runTransaction(SESSION_STORE, "readwrite", (store) => store.put(record))
  }

  async updateSessionRecord(sessionId, patch) {
    const current = (await this.getSessionRecord(sessionId)) || { sessionId }
    await this.upsertSessionRecord({ ...current, ...patch })
  }

  async listRecentSessions() {
    const sessions = (await this.runTransaction(SESSION_STORE, "readonly", (store) => idbRequest(store.getAll()))) || []
    return sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 30)
  }

  async listSessionsByStatus(status) {
    const sessions = (await this.runTransaction(SESSION_STORE, "readonly", (store) => {
      const index = store.index("status")
      return idbRequest(index.getAll(status))
    })) || []
    return sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }

  async putChunk(record) {
    return this.runTransaction(CHUNK_STORE, "readwrite", (store) => store.put(record))
  }

  async getChunksBySession(sessionId, fileId) {
    const all = (await this.runTransaction(CHUNK_STORE, "readonly", (store) => {
      const index = store.index("sessionId")
      return idbRequest(index.getAll(sessionId))
    })) || []
    return all
      .filter((item) => item.sessionId === sessionId && item.fileId === fileId)
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
  }

  async buildBlobFromChunks(sessionId, fileId) {
    const chunks = await this.getChunksBySession(sessionId, fileId)
    return new Blob(chunks.map((item) => item.data))
  }

  async clearChunksBySession(sessionId) {
    const targets = (await this.runTransaction(CHUNK_STORE, "readonly", (store) => {
      const index = store.index("sessionId")
      return idbRequest(index.getAll(sessionId))
    })) || []
    await this.runTransaction(CHUNK_STORE, "readwrite", (store) => {
      targets.forEach((item) => store.delete(item.chunkKey))
    })
  }

  async clearStore(storeName) {
    return this.runTransaction(storeName, "readwrite", (store) => store.clear())
  }

  runTransaction(storeName, mode, work) {
    if (!this.state.db) {
      return Promise.resolve(null)
    }
    return new Promise((resolve, reject) => {
      const tx = this.state.db.transaction(storeName, mode)
      const store = tx.objectStore(storeName)
      const result = work(store)
      tx.oncomplete = async () => resolve(await result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  }
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
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

function detectRuntimeCapabilities() {
  const userAgent = navigator.userAgent || ""
  const isIPhone = /iPhone/i.test(userAgent)
  const isIPad = /iPad/i.test(userAgent) || (/Macintosh/i.test(userAgent) && "ontouchend" in document)
  const isAndroid = /Android/i.test(userAgent)
  const isWebKit = /AppleWebKit/i.test(userAgent)
  const isCriOS = /CriOS/i.test(userAgent)
  const isFxiOS = /FxiOS/i.test(userAgent)
  const isEdgiOS = /EdgiOS/i.test(userAgent)
  const isIOSSafari = (isIPhone || isIPad) && isWebKit && !isCriOS && !isFxiOS && !isEdgiOS
  const isIOSWebKitBrowser = (isIPhone || isIPad) && isWebKit
  return {
    isAndroid,
    isIOSSafari,
    isIOSWebKitBrowser,
    isMobileBrowser: isIPhone || isIPad || isAndroid,
  }
}

class TransferCancelledError extends Error {
  constructor(message) {
    super(message)
    this.name = "TransferCancelledError"
  }
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

function serializeIceCandidate(candidate) {
  if (!candidate) {
    return null
  }
  if (typeof candidate.toJSON === "function") {
    return candidate.toJSON()
  }
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment,
  }
}

function deserializeIceCandidate(candidate) {
  if (!candidate) {
    return null
  }
  if (typeof RTCIceCandidate === "function") {
    return new RTCIceCandidate(candidate)
  }
  return candidate
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index])
  }
  return btoa(binary)
}

function base64ToArrayBuffer(value) {
  const binary = atob(value || "")
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes.buffer
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
  anchor.rel = "noopener"
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
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

function sha256Fallback(bytes) {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ])

  const H = new Uint32Array([
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ])

  const bitLength = bytes.length * 8
  const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80

  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 4, bitLength >>> 0, false)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false)

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

function rightRotate(value, bits) {
  return (value >>> bits) | (value << (32 - bits))
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
    localView.setUint16(8, 0, true)
    localView.setUint16(10, 0, true)
    localView.setUint32(14, file.crc, true)
    localView.setUint32(18, file.data.length, true)
    localView.setUint32(22, file.data.length, true)
    localView.setUint16(26, file.nameBytes.length, true)
    localHeader.set(file.nameBytes, 30)
    localParts.push(localHeader, file.data)

    const centralHeader = new Uint8Array(46 + file.nameBytes.length)
    const centralView = new DataView(centralHeader.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(10, 0, true)
    centralView.setUint16(12, 0, true)
    centralView.setUint32(16, file.crc, true)
    centralView.setUint32(20, file.data.length, true)
    centralView.setUint32(24, file.data.length, true)
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
