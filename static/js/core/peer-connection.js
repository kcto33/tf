import { DEFAULT_ICE_SERVERS } from "../constants.js"
import { base64ToArrayBuffer } from "../utils/base64.js"
import { deserializeIceCandidate, serializeIceCandidate } from "../utils/webrtc.js"

// WebRTC 连接管理：RTCPeerConnection 生命周期、ICE 候选排队、DataChannel 事件，
// 以及直连/中继两条路径上统一的数据消息分发。
export class PeerConnectionController {
  constructor(app) {
    this.app = app
  }

  async ensurePeerConnection(peerId, initiator) {
    if (!this.app.state.peers.has(peerId)) {
      return null
    }
    let connection = this.app.state.connections.get(peerId)
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
    this.app.state.connections.set(peerId, connection)

    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        this.app.appendLog(`${this.app.getPeerName(peerId)} ICE 候选收集完成。`, "info")
        this.app.sendSignal({
          type: "ice_candidate",
          target_client_id: peerId,
          candidate: null,
        })
        return
      }
      this.app.appendLog(`${this.app.getPeerName(peerId)} 生成 ICE 候选。`, "info")
      this.app.sendSignal({
        type: "ice_candidate",
        target_client_id: peerId,
        candidate: serializeIceCandidate(event.candidate),
      })
    }

    pc.onconnectionstatechange = () => {
      connection.connectionState = pc.connectionState || "new"
      this.app.appendLog(
        `${this.app.getPeerName(peerId)} 连接状态: ${connection.connectionState}`,
        connection.connectionState === "failed" ? "warn" : "info"
      )
      this.app.notify()
    }

    pc.oniceconnectionstatechange = () => {
      this.app.appendLog(
        `${this.app.getPeerName(peerId)} ICE 状态: ${pc.iceConnectionState || "new"}`,
        ["failed", "disconnected", "closed"].includes(pc.iceConnectionState || "") ? "warn" : "info"
      )
      this.app.notify()
    }

    pc.onicegatheringstatechange = () => {
      this.app.appendLog(`${this.app.getPeerName(peerId)} ICE 收集中: ${pc.iceGatheringState || "new"}`, "info")
      this.app.notify()
    }

    pc.onsignalingstatechange = () => {
      this.app.appendLog(`${this.app.getPeerName(peerId)} 信令状态: ${pc.signalingState || "stable"}`, "info")
      this.app.notify()
    }

    pc.ondatachannel = (event) => {
      this.attachDataChannel(peerId, event.channel)
    }

    if (initiator) {
      this.attachDataChannel(peerId, pc.createDataChannel("file-transfer", { ordered: true }))
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      this.app.appendLog(`已向 ${this.app.getPeerName(peerId)} 发送 WebRTC offer。`, "info")
      this.app.sendSignal({
        type: "webrtc_offer",
        target_client_id: peerId,
        sdp: offer,
      })
    }

    this.app.notify()
    return connection
  }

  async onOffer(message) {
    const connection = await this.app.ensurePeerConnection(message.from_client_id, false)
    this.app.appendLog(`收到 ${this.app.getPeerName(message.from_client_id)} 的 WebRTC offer。`, "info")
    await connection.pc.setRemoteDescription(message.sdp)
    await this.flushPendingIceCandidates(connection)
    const answer = await connection.pc.createAnswer()
    await connection.pc.setLocalDescription(answer)
    this.app.appendLog(`已向 ${this.app.getPeerName(message.from_client_id)} 发送 WebRTC answer。`, "info")
    this.app.sendSignal({
      type: "webrtc_answer",
      target_client_id: message.from_client_id,
      sdp: answer,
    })
  }

  async onAnswer(message) {
    const connection = this.app.state.connections.get(message.from_client_id)
    if (!connection) {
      return
    }
    this.app.appendLog(`收到 ${this.app.getPeerName(message.from_client_id)} 的 WebRTC answer。`, "info")
    await connection.pc.setRemoteDescription(message.sdp)
    await this.flushPendingIceCandidates(connection)
  }

  async onIceCandidate(message) {
    const connection = this.app.state.connections.get(message.from_client_id)
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
        this.app.appendLog(`已标记 ${this.app.getPeerName(message.from_client_id)} 的 ICE 候选结束。`, "info")
      } catch (error) {
        this.app.appendLog(`ICE 结束标记处理失败: ${error.message}`, "warn")
      }
      return
    }
    if (!connection.pc.remoteDescription) {
      this.app.appendLog(`${this.app.getPeerName(message.from_client_id)} 的 ICE 候选已排队，等待远端描述。`, "info")
      connection.pendingIceCandidates.push(message.candidate)
      return
    }
    try {
      await connection.pc.addIceCandidate(deserializeIceCandidate(message.candidate))
      this.app.appendLog(`已应用 ${this.app.getPeerName(message.from_client_id)} 的 ICE 候选。`, "info")
    } catch (error) {
      this.app.appendLog(`ICE 候选处理失败: ${error.message}`, "warn")
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
        this.app.appendLog(
          candidate == null
            ? `已补充标记 ${this.app.getPeerName(connection.peerId)} 的 ICE 候选结束。`
            : `已补充应用 ${this.app.getPeerName(connection.peerId)} 的 ICE 候选。`,
          "info"
        )
      } catch (error) {
        this.app.appendLog(`补充 ICE 候选失败: ${error.message}`, "warn")
      }
    }
  }

  attachDataChannel(peerId, channel) {
    const connection = this.app.state.connections.get(peerId)
    if (!connection) {
      return
    }

    connection.channel = channel
    connection.channelState = channel.readyState
    channel.binaryType = "arraybuffer"
    this.app.appendLog(`${this.app.getPeerName(peerId)} 的 DataChannel 已创建: ${channel.label}。`, "info")

    channel.onopen = async () => {
      connection.channelState = "open"
      this.app.appendLog(`${this.app.getPeerName(peerId)} 的传输通道已打开。`, "info")
      await this.app.resumePendingSessions(peerId)
      await this.app.resumePendingOutgoing()
    }

    channel.onclose = () => {
      connection.channelState = "closed"
      connection.sendingSessionId = null
      this.app.appendLog(`${this.app.getPeerName(peerId)} 的传输通道已关闭。`, "warn")
    }

    channel.onerror = () => {
      connection.channelState = "error"
      this.app.notify()
    }

    channel.onmessage = async (event) => {
      await this.handleChannelMessage(peerId, event.data)
    }

    this.app.notify()
  }

  closePeerConnection(peerId) {
    const connection = this.app.state.connections.get(peerId)
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
    this.app.state.connections.delete(peerId)
  }

  closeAllPeerConnections() {
    for (const peerId of Array.from(this.app.state.connections.keys())) {
      this.closePeerConnection(peerId)
    }
  }

  // 直连 DataChannel 与中继 control 消息共用这一份分发逻辑。
  async handleDataMessage(peerId, message) {
    switch (message.type) {
      case "session_start":
        this.app.appendLog(`开始接收 ${this.app.getPeerName(peerId)} 的会话 ${message.session_id}。`, "info")
        break
      case "chat_message":
        this.app.onChatMessage(peerId, message)
        break
      case "file_start":
        this.app.appendLog(`开始接收 ${message.relative_path}。`, "info")
        break
      case "chunk":
        {
          const connection = this.app.getConnection(peerId)
          if (connection) {
            connection.expectedChunkHeader = message
          }
        }
        break
      case "file_end":
        await this.app.finalizeIncomingFile(message)
        break
      case "session_progress":
        this.app.onSessionProgress(message)
        break
      case "session_complete":
        await this.app.finalizeIncomingSession(message.session_id)
        break
      case "session_received":
        this.app.onSessionReceived(message)
        break
      case "chat_file_start":
      case "chat_file_chunk":
      case "chat_file_end":
        this.app.onChatFileSignal(peerId, message)
        break
      default:
        this.app.appendLog(`忽略未知数据消息 ${message.type}。`, "warn")
    }
  }

  async handleChannelMessage(peerId, payload) {
    const connection = this.app.getConnection(peerId)
    if (!connection) {
      return
    }

    if (typeof payload === "string") {
      const message = JSON.parse(payload)
      await this.handleDataMessage(peerId, message)
      return
    }

    if (!connection.expectedChunkHeader) {
      this.app.appendLog("收到未匹配头信息的二进制数据。", "warn")
      return
    }

    const header = connection.expectedChunkHeader
    connection.expectedChunkHeader = null
    await this.app.storeIncomingChunk(header, payload)
  }

  async onRelayPayload(message) {
    const peerId = message.from_client_id
    const relayMessage = message.payload
    if (!relayMessage) {
      return
    }
    let connection = this.app.getConnection(peerId)
    if (!connection) {
      await this.app.ensurePeerConnection(peerId, false)
      connection = this.app.getConnection(peerId)
    }
    if (!connection) {
      return
    }

    if (relayMessage.relay_type === "binary") {
      const header = relayMessage.header || connection.expectedChunkHeader
      if (!header) {
        this.app.appendLog("收到未匹配头信息的中继二进制数据。", "warn")
        return
      }
      connection.expectedChunkHeader = null
      await this.app.storeIncomingChunk(header, base64ToArrayBuffer(relayMessage.data_b64 || ""))
      return
    }

    if (relayMessage.relay_type === "control" && relayMessage.payload) {
      const payload = relayMessage.payload
      if (payload.type === "chunk") {
        connection.expectedChunkHeader = payload
        return
      }
      await this.handleDataMessage(peerId, payload)
      return
    }

    await this.handleDataMessage(peerId, relayMessage)
  }

  sendTransferControl(peerId, transport, connection, payload) {
    if (transport === "p2p") {
      this.sendDataControl(connection.channel, payload)
      return
    }
    this.app.sendRelayPayload(peerId, {
      relay_type: "control",
      payload,
    })
  }

  sendDataControl(channel, payload) {
    if (!channel || channel.readyState !== "open") {
      throw new Error("DataChannel 未打开。")
    }
    channel.send(JSON.stringify(payload))
  }
}
