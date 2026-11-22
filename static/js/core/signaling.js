import {
  DEFAULT_ROOM_CODE,
  DISPLAY_NAME_STORAGE_KEY,
  ROOM_CODE_STORAGE_KEY,
} from "../constants.js"
import { makeId } from "../utils/id.js"

// 房间与信令：WebSocket 连接生命周期、房间内设备登记、目标选择，
// 以及信令消息到各控制器的分发。
export class SignalingController {
  constructor(app) {
    this.app = app
  }

  async connectToRoom(roomCodeInput, displayNameInput) {
    try {
      const roomCode = String(roomCodeInput || "").trim()
      const displayName = String(displayNameInput || "").trim() || `PC-${Math.floor(Math.random() * 1000)}`
      if (!roomCode) {
        this.app.appendLog("请输入房间码。", "warn")
        return
      }

      await this.app.disconnectFromRoom()
      this.app.state.roomCode = roomCode
      this.app.state.displayName = displayName
      this.app.state.formRoomCode = roomCode
      this.app.state.formDisplayName = displayName
      this.app.state.clientId = makeId()
      localStorage.setItem(DISPLAY_NAME_STORAGE_KEY, displayName)
      localStorage.setItem(ROOM_CODE_STORAGE_KEY, roomCode)

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws/signaling`)
      this.app.state.ws = socket
      this.app.notify()

      socket.addEventListener("open", () => {
        if (this.app.state.ws !== socket) {
          return
        }
        this.app.sendSignal({
          type: "join_room",
          room_code: roomCode,
          client_id: this.app.state.clientId,
          display_name: displayName,
        })
        this.app.appendLog(`已进入房间 ${roomCode}。`, "info")
      })

      socket.addEventListener("message", async (event) => {
        if (this.app.state.ws !== socket) {
          return
        }
        await this.app.handleSignalMessage(JSON.parse(event.data))
      })

      socket.addEventListener("error", () => {
        if (this.app.state.ws !== socket) {
          return
        }
        this.app.appendLog("信令连接失败。请确认访问的是正确 IP 和端口。", "danger")
      })

      socket.addEventListener("close", () => {
        if (this.app.state.ws !== socket) {
          return
        }
        this.app.state.ws = null
        this.app.appendLog("信令连接已断开。", "warn")
        this.app.resetRoomState()
      })
    } catch (error) {
      this.app.appendLog(`进入房间失败: ${error.message}`, "danger")
    }
  }

  async disconnectFromRoom() {
    if (this.app.disconnectPromise) {
      return this.app.disconnectPromise
    }

    this.app.disconnectPromise = (async () => {
      await this.app.waitForPendingReceiverAcks()
      if (this.app.state.ws) {
        const socket = this.app.state.ws
        this.app.state.ws = null
        socket.close()
      }
      this.app.resetRoomState()
    })()

    try {
      await this.app.disconnectPromise
    } finally {
      this.app.disconnectPromise = null
    }
  }

  resetRoomState() {
    this.app.closeAllPeerConnections()
    this.app.incomingChunkState.clear()
    this.app.state.outgoingSessions.clear()
    this.app.state.peers.clear()
    this.app.state.connections.clear()
    this.app.state.pendingIncomingRequests.clear()
    this.app.state.chatMessages.clear()
    this.app.state.unreadMessages.clear()
    this.app.state.chatFileTransfers.clear()
    this.app.state.pendingOutgoingResumes.clear()
    this.app.state.selectedPeerId = null
    this.app.state.selectedTransferPeerIds.clear()
    this.app.state.clientId = ""
    this.app.clearTransferStatus()
    this.app.notify()
  }

  async handleSignalMessage(message) {
    switch (message.type) {
      case "joined_room":
        this.app.state.clientId = message.client_id
        for (const peer of message.peers) {
          this.upsertPeer(peer)
          await this.app.ensurePeerConnection(peer.client_id, this.app.state.clientId.localeCompare(peer.client_id) < 0)
        }
        this.pickFallbackPeer()
        await this.app.resumePendingSessions()
        await this.app.resumePendingOutgoing()
        this.app.notify()
        break
      case "peer_joined":
        this.upsertPeer({ client_id: message.client_id, display_name: message.display_name })
        this.app.appendLog(`设备 ${message.display_name} 已进入房间。`, "info")
        await this.app.ensurePeerConnection(message.client_id, this.app.state.clientId.localeCompare(message.client_id) < 0)
        this.pickFallbackPeer()
        await this.app.resumePendingSessions(message.client_id)
        await this.app.resumePendingOutgoing()
        this.app.notify()
        break
      case "peer_left":
        this.app.appendLog(`设备 ${this.app.getPeerName(message.client_id)} 已离开。`, "warn")
        this.removePeer(message.client_id)
        this.app.notify()
        break
      case "webrtc_offer":
        await this.app.onOffer(message)
        break
      case "webrtc_answer":
        await this.app.onAnswer(message)
        break
      case "ice_candidate":
        await this.app.onIceCandidate(message)
        break
      case "transfer_request":
        await this.app.onTransferRequest(message)
        break
      case "transfer_accept":
        await this.app.onTransferAccept(message)
        break
      case "transfer_reject":
        await this.app.onTransferReject(message)
        break
      case "transfer_cancel":
        await this.app.onTransferCancel(message)
        break
      case "transfer_abort":
        await this.app.onTransferAbort(message)
        break
      case "relay_payload":
        await this.app.onRelayPayload(message)
        break
      case "resume_request":
        await this.app.onResumeRequest(message)
        break
      case "resume_state":
        await this.app.onResumeState(message)
        break
      case "error":
        this.app.appendLog(message.message, "danger")
        break
      default:
        this.app.appendLog(`忽略未知信令消息 ${message.type}。`, "warn")
    }
  }

  upsertPeer(peer) {
    if (!peer || !peer.client_id || peer.client_id === this.app.state.clientId) {
      return
    }
    this.app.state.peers.set(peer.client_id, {
      client_id: peer.client_id,
      display_name: peer.display_name || peer.client_id,
    })
  }

  removePeer(peerId) {
    this.app.state.peers.delete(peerId)
    this.app.state.selectedTransferPeerIds.delete(peerId)
    this.app.closePeerConnection(peerId)
    for (const request of this.app.state.pendingIncomingRequests.values()) {
      if (request.fromClientId === peerId) {
        this.app.state.pendingIncomingRequests.delete(request.sessionId)
      }
    }
    if (this.app.state.selectedPeerId === peerId) {
      this.app.state.selectedPeerId = null
      this.pickFallbackPeer()
    }
  }

  pickFallbackPeer() {
    if (this.app.state.selectedPeerId && this.app.state.peers.has(this.app.state.selectedPeerId)) {
      if (!this.app.state.selectedTransferPeerIds.size && this.app.state.peers.size === 1) {
        this.app.state.selectedTransferPeerIds.add(this.app.state.selectedPeerId)
      }
      return
    }
    const nextPeerCandidate = this.app.state.peers.keys().next().value
    this.app.state.selectedPeerId = nextPeerCandidate === undefined ? null : nextPeerCandidate
    if (!this.app.state.selectedTransferPeerIds.size && this.app.state.peers.size === 1 && this.app.state.selectedPeerId) {
      this.app.state.selectedTransferPeerIds.add(this.app.state.selectedPeerId)
    }
  }

  selectPeer(peerId) {
    if (!this.app.state.peers.has(peerId)) {
      return
    }
    this.app.state.selectedPeerId = peerId
    if (!this.app.state.selectedTransferPeerIds.size) {
      this.app.state.selectedTransferPeerIds.add(peerId)
    }
    this.app.state.unreadMessages.set(peerId, 0)
    this.app.notify()
  }

  toggleTransferPeer(peerId, force = null) {
    if (!this.app.state.peers.has(peerId)) {
      return
    }
    const shouldSelect = force === null ? !this.app.state.selectedTransferPeerIds.has(peerId) : Boolean(force)
    if (shouldSelect) {
      this.app.state.selectedTransferPeerIds.add(peerId)
      if (!this.app.state.selectedPeerId) {
        this.app.state.selectedPeerId = peerId
      }
    } else {
      this.app.state.selectedTransferPeerIds.delete(peerId)
    }
    this.app.notify()
  }

  sendSignal(payload) {
    if (!this.app.state.ws || this.app.state.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket 未连接。")
    }
    this.app.state.ws.send(JSON.stringify(payload))
  }

  sendRelayPayload(peerId, payload) {
    this.sendSignal({
      type: "relay_payload",
      target_client_id: peerId,
      payload,
    })
  }
}
