import {
  DEFAULT_ROOM_CODE,
  DISPLAY_NAME_STORAGE_KEY,
  MAX_LOGS,
  ROOM_CODE_STORAGE_KEY,
} from "../constants.js"
import { makeId, makeDefaultDisplayName } from "../utils/id.js"
import { detectRuntimeCapabilities } from "../utils/runtime.js"
import { SessionStore, openDatabase } from "../storage/session-store.js"
import { SignalingController } from "./signaling.js"
import { PeerConnectionController } from "./peer-connection.js"
import { ReceiverController } from "./receiver.js"
import { SenderController } from "./sender.js"
import { ChatController } from "./chat.js"

// 各领域控制器共享 app 上下文；这里显式声明每个控制器对外暴露的方法名，
// 在 app 实例上生成转发包装，测试可以照旧 monkey-patch app 级方法。
const CONTROLLER_METHODS = [
  [
    SignalingController,
    [
      "connectToRoom",
      "disconnectFromRoom",
      "resetRoomState",
      "handleSignalMessage",
      "upsertPeer",
      "removePeer",
      "pickFallbackPeer",
      "selectPeer",
      "toggleTransferPeer",
      "sendSignal",
      "sendRelayPayload",
    ],
  ],
  [
    PeerConnectionController,
    [
      "ensurePeerConnection",
      "onOffer",
      "onAnswer",
      "onIceCandidate",
      "flushPendingIceCandidates",
      "attachDataChannel",
      "closePeerConnection",
      "closeAllPeerConnections",
      "handleChannelMessage",
      "onRelayPayload",
      "sendTransferControl",
      "sendDataControl",
    ],
  ],
  [
    ReceiverController,
    [
      "shouldAvoidRelayForSize",
      "shouldBlockIncomingTransfer",
      "ensureIncomingChunkState",
      "flushIncomingChunkState",
      "clearIncomingChunkState",
      "sendIncomingProgress",
      "sendIncomingSessionAck",
      "onTransferRequest",
      "acceptIncomingTransfer",
      "rejectIncomingTransfer",
      "cancelIncomingSession",
      "storeIncomingChunk",
      "shouldSkipChecksum",
      "finalizeIncomingFile",
      "finalizeIncomingSession",
      "resumePendingSessions",
    ],
  ],
  [
    SenderController,
    [
      "startTransferRequest",
      "sendOutgoingSession",
      "cancelOutgoingSession",
      "finalizeOutgoingCancellation",
      "onTransferAccept",
      "onTransferReject",
      "onTransferCancel",
      "onTransferAbort",
      "onResumeRequest",
      "onResumeState",
      "onSessionReceived",
      "onSessionProgress",
      "updateOutgoingTransferStatus",
      "waitForReceiverCompletion",
      "waitForPendingReceiverAcks",
      "resumePendingOutgoing",
      "completeOutgoingResume",
    ],
  ],
  [
    ChatController,
    ["pushChatMessage", "sendChatMessage", "sendChatAttachment", "onChatMessage", "onChatFileSignal"],
  ],
]

function bindControllers(app) {
  for (const [Controller, methods] of CONTROLLER_METHODS) {
    const controller = new Controller(app)
    for (const method of methods) {
      app[method] = (...args) => controller[method](...args)
    }
  }
}

// 传输应用中枢：持有全部共享状态（房间、设备、连接、会话、聊天、日志），
// 领域逻辑分布在 core/ 下的各控制器，存储委托给 storage/session-store.js。
export class TransferApp {
  constructor(options = {}) {
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
    this.disconnectPromise = null
    this.store = null
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
      selectedTransferPeerIds: new Set(),
      selectedFiles: [],
      pendingIncomingRequests: new Map(),
      outgoingSessions: new Map(),
      chatMessages: new Map(),
      unreadMessages: new Map(),
      chatFileTransfers: new Map(),
      pendingOutgoingResumes: new Map(),
      history: [],
      logs: [],
      transferStatus: null,
    }
    bindControllers(this)
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
      const db = await openDatabase()
      this.store = new SessionStore(db)
      this.state.db = db
      await this.refreshHistory()
    } catch (error) {
      this.appendLog(`本地存储初始化失败: ${error.message}`, "warn")
    }
    if (this.runtime.isIOSWebKitBrowser) {
      this.appendLog("Large-file receive on iPhone browsers is limited. Safer limits are enabled.", "warn")
    }
    if (!this.isConnected() && this.state.formRoomCode) {
      await this.connectToRoom(this.state.formRoomCode, this.state.formDisplayName)
    }
    this.notify()
  }

  restoreFormState() {
    const params = new URLSearchParams(window.location.search)
    const displayName = params.get("name") || localStorage.getItem(DISPLAY_NAME_STORAGE_KEY) || makeDefaultDisplayName()
    const roomCode = params.get("room") || localStorage.getItem(ROOM_CODE_STORAGE_KEY) || DEFAULT_ROOM_CODE
    this.state.formDisplayName = displayName
    this.state.formRoomCode = roomCode
    localStorage.setItem(DISPLAY_NAME_STORAGE_KEY, displayName)
    localStorage.setItem(ROOM_CODE_STORAGE_KEY, roomCode)
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

  getSelectedTransferPeerIds() {
    return Array.from(this.state.selectedTransferPeerIds.values()).filter((peerId) => this.state.peers.has(peerId))
  }

  getSelectedTransferPeers() {
    return this.getSelectedTransferPeerIds()
      .map((peerId) => this.state.peers.get(peerId) || null)
      .filter(Boolean)
  }

  isTransferPeerSelected(peerId) {
    return this.state.selectedTransferPeerIds.has(peerId) && this.state.peers.has(peerId)
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

  isConnected() {
    return Boolean(this.state.ws && this.state.ws.readyState === WebSocket.OPEN)
  }

  hasActiveTransfers() {
    return Boolean(this.getTransferAction()) || this.state.pendingIncomingRequests.size > 0
  }

  setSelectedFiles(items) {
    const files = Array.from(items || [])
    this.state.selectedFiles = this.options.allowMultipleFiles ? files : files.slice(0, 1)
    this.notify()
  }

  removeSelectedFile(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.state.selectedFiles.length) {
      return false
    }
    this.state.selectedFiles = this.state.selectedFiles.filter((_, itemIndex) => itemIndex !== index)
    this.notify()
    return true
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

  async clearHistory() {
    if (this.store) {
      await this.store.clearAll()
    }
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

  // ---- IndexedDB 存储委托：保持 app 级方法名，便于测试替换与上层调用 ----

  runTransaction(storeName, mode, work) {
    if (!this.store) {
      return Promise.resolve(null)
    }
    return this.store.runTransaction(storeName, mode, work)
  }

  async getSessionRecord(sessionId) {
    if (!this.store) {
      return null
    }
    return this.store.getSessionRecord(sessionId)
  }

  async upsertSessionRecord(record) {
    if (!this.store) {
      return null
    }
    return this.store.upsertSessionRecord(record)
  }

  async updateSessionRecord(sessionId, patch) {
    if (!this.store) {
      return null
    }
    return this.store.updateSessionRecord(sessionId, patch)
  }

  async listRecentSessions() {
    if (!this.store) {
      return []
    }
    return this.store.listRecentSessions()
  }

  async listSessionsByStatus(status) {
    if (!this.store) {
      return []
    }
    return this.store.listSessionsByStatus(status)
  }

  async putChunk(record) {
    if (!this.store) {
      return null
    }
    return this.store.putChunk(record)
  }

  async getChunksBySession(sessionId, fileId) {
    if (!this.store) {
      return []
    }
    return this.store.getChunksBySession(sessionId, fileId)
  }

  async buildBlobFromChunks(sessionId, fileId) {
    if (!this.store) {
      return new Blob([])
    }
    return this.store.buildBlobFromChunks(sessionId, fileId)
  }

  async clearChunksBySession(sessionId) {
    if (!this.store) {
      return null
    }
    return this.store.clearChunksBySession(sessionId)
  }

  async clearStore(storeName) {
    if (!this.store) {
      return null
    }
    return this.store.clearStore(storeName)
  }
}
