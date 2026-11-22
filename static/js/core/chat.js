import {
  CHAT_FILE_CHUNK_SIZE,
  CHAT_FILE_MAX_BYTES,
  CHAT_FILE_MAX_PENDING_BYTES,
} from "../constants.js"
import { makeId } from "../utils/id.js"
import { arrayBufferToBase64, base64ToArrayBuffer } from "../utils/base64.js"
import { waitForBufferedAmount } from "../utils/webrtc.js"
import { notifyIfHidden } from "../utils/notify.js"

// 聊天消息：文本与附件（图片/文件）。
// 文本走 chat_message；附件走 chat_file_start/chunk/end 三段分块协议，
// DataChannel 与中继都承载 JSON，无需触碰文件传输会话的二进制 chunk 流。
export class ChatController {
  constructor(app) {
    this.app = app
  }

  pushChatMessage(peerId, message) {
    const existing = this.app.getChatMessages(peerId)
    this.app.state.chatMessages.set(peerId, existing.concat(message).slice(-200))
  }

  async sendChatMessage(textInput) {
    const peerId = this.requireChatTarget()
    if (!peerId) {
      return false
    }

    const text = String(textInput || "").trim()
    if (!text) {
      return false
    }

    const timestamp = Date.now()
    const payload = {
      type: "chat_message",
      message_id: makeId(),
      text,
      sent_at: timestamp,
    }
    if (!this.sendChatControl(peerId, payload, `已通过中继发送消息到 ${this.app.getPeerName(peerId)}。`)) {
      return false
    }

    this.pushChatMessage(peerId, {
      id: payload.message_id,
      direction: "outgoing",
      peerName: this.app.getPeerName(peerId),
      text,
      timestamp,
    })
    this.app.notify()
    return true
  }

  requireChatTarget() {
    const peerId = this.app.state.selectedPeerId
    if (!peerId) {
      this.app.appendLog("先选择一台设备，再发送消息。", "warn")
      return null
    }
    return peerId
  }

  // 优先直连，未就绪时走中继；两条路都不可用返回 false。
  sendChatControl(peerId, payload, relayLog) {
    const connection = this.app.getOpenConnection(peerId)
    if (connection) {
      this.app.sendDataControl(connection.channel, payload)
      return true
    }
    if (!this.app.isConnected()) {
      this.app.appendLog("目标设备的消息通道尚未就绪。", "warn")
      return false
    }
    this.app.sendRelayPayload(peerId, payload)
    if (relayLog) {
      this.app.appendLog(relayLog, "info")
    }
    return true
  }

  async sendChatAttachment(file) {
    const peerId = this.requireChatTarget()
    if (!peerId) {
      return false
    }

    const size = Number(file.size) || 0
    if (size <= 0) {
      this.app.appendLog(`跳过空文件: ${file.name}`, "warn")
      return false
    }
    if (size > CHAT_FILE_MAX_BYTES) {
      this.app.appendLog(
        `文件超过聊天附件上限（${Math.round(CHAT_FILE_MAX_BYTES / 1024 / 1024)}MB），请使用文件传输: ${file.name}`,
        "warn"
      )
      return false
    }

    const bytes = new Uint8Array(await file.arrayBuffer())
    const chunkCount = Math.max(Math.ceil(bytes.length / CHAT_FILE_CHUNK_SIZE), 1)
    const messageId = makeId()
    const mime = file.type || guessMimeFromName(file.name)
    const meta = {
      name: file.name,
      size: bytes.length,
      mime,
      isImage: isImageAttachment(mime, file.name),
    }

    const started = this.sendChatControl(
      peerId,
      {
        type: "chat_file_start",
        message_id: messageId,
        name: meta.name,
        size: meta.size,
        mime: meta.mime,
        is_image: meta.isImage,
        chunk_size: CHAT_FILE_CHUNK_SIZE,
        chunk_count: chunkCount,
        sent_at: Date.now(),
      },
      `已通过中继发送附件到 ${this.app.getPeerName(peerId)}。`
    )
    if (!started) {
      return false
    }

    try {
      for (let index = 0; index < chunkCount; index += 1) {
        const start = index * CHAT_FILE_CHUNK_SIZE
        const chunk = bytes.subarray(start, Math.min(start + CHAT_FILE_CHUNK_SIZE, bytes.length))
        const connection = this.app.getOpenConnection(peerId)
        if (connection) {
          await waitForBufferedAmount(connection.channel, chunk.length)
        }
        this.sendChatControl(peerId, {
          type: "chat_file_chunk",
          message_id: messageId,
          chunk_index: index,
          data_b64: arrayBufferToBase64(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)),
        })
      }
      this.sendChatControl(peerId, { type: "chat_file_end", message_id: messageId })
    } catch (error) {
      this.app.appendLog(`附件发送中断: ${error.message}`, "danger")
      return false
    }

    this.pushChatMessage(peerId, {
      id: messageId,
      direction: "outgoing",
      peerName: this.app.getPeerName(peerId),
      text: "",
      timestamp: Date.now(),
      attachment: {
        ...meta,
        url: URL.createObjectURL(new Blob([bytes], { type: meta.mime || "application/octet-stream" })),
      },
    })
    this.app.notify()
    return true
  }

  onChatFileSignal(peerId, message) {
    if (message.type === "chat_file_start") {
      this.startPendingChatFile(peerId, message)
      return
    }
    if (message.type === "chat_file_chunk") {
      this.appendPendingChatFileChunk(peerId, message)
      return
    }
    if (message.type === "chat_file_end") {
      void this.finalizePendingChatFile(peerId, message)
    }
  }

  startPendingChatFile(peerId, message) {
    const size = Number(message.size) || 0
    if (size > CHAT_FILE_MAX_PENDING_BYTES) {
      this.app.appendLog(
        `忽略超大聊天附件 ${message.name || "未命名"}（${formatBytesLabel(size)}），请使用文件传输。`,
        "warn"
      )
      return
    }
    // 同 id 重新开始：丢弃旧的部分数据。
    this.app.state.chatFileTransfers.set(message.message_id, {
      peerId,
      name: String(message.name || "未命名文件"),
      size,
      mime: String(message.mime || ""),
      isImage: Boolean(message.is_image),
      chunkSize: Number(message.chunk_size) || CHAT_FILE_CHUNK_SIZE,
      chunkCount: Math.max(Number(message.chunk_count) || 1, 1),
      receivedChunks: new Map(),
      receivedBytes: 0,
      createdAt: Date.now(),
      warnedOverflow: false,
    })
  }

  appendPendingChatFileChunk(peerId, message) {
    const pending = this.app.state.chatFileTransfers.get(message.message_id)
    if (!pending || pending.peerId !== peerId) {
      return
    }
    const index = Number(message.chunk_index)
    if (!Number.isInteger(index) || index < 0 || index >= pending.chunkCount) {
      return
    }
    if (pending.receivedChunks.has(index)) {
      return
    }

    const bytes = new Uint8Array(base64ToArrayBuffer(String(message.data_b64 || "")))
    pending.receivedChunks.set(index, bytes)
    pending.receivedBytes += bytes.length

    if (pending.receivedBytes > CHAT_FILE_MAX_PENDING_BYTES && !pending.warnedOverflow) {
      pending.warnedOverflow = true
      this.app.appendLog(`聊天附件 ${pending.name} 数据异常，已忽略后续分块。`, "warn")
      this.app.state.chatFileTransfers.delete(message.message_id)
    }
  }

  async finalizePendingChatFile(peerId, message) {
    const pending = this.app.state.chatFileTransfers.get(message.message_id)
    if (!pending || pending.peerId !== peerId) {
      return
    }
    this.app.state.chatFileTransfers.delete(message.message_id)

    if (pending.receivedChunks.size !== pending.chunkCount) {
      this.app.appendLog(
        `附件 ${pending.name} 接收不完整（${pending.receivedChunks.size}/${pending.chunkCount} 块），已丢弃。`,
        "warn"
      )
      return
    }

    const parts = Array.from(pending.receivedChunks.keys())
      .sort((left, right) => left - right)
      .map((key) => pending.receivedChunks.get(key))
    const blob = new Blob(parts, { type: pending.mime || "application/octet-stream" })
    if (blob.size !== pending.size) {
      this.app.appendLog(`附件 ${pending.name} 大小校验失败，已丢弃。`, "warn")
      return
    }

    this.pushChatMessage(peerId, {
      id: message.message_id,
      direction: "incoming",
      peerName: this.app.getPeerName(peerId),
      text: "",
      timestamp: Number(message.sent_at) || Date.now(),
      attachment: {
        name: pending.name,
        size: blob.size,
        mime: pending.mime,
        isImage: pending.isImage,
        url: URL.createObjectURL(blob),
      },
    })
    notifyIfHidden(`来自 ${this.app.getPeerName(peerId)} 的附件`, pending.name)
    if (this.app.state.selectedPeerId !== peerId) {
      this.app.state.unreadMessages.set(peerId, this.app.getUnreadCount(peerId) + 1)
      this.app.appendLog(`${this.app.getPeerName(peerId)} 发来一个附件。`, "info")
      return
    }
    this.app.notify()
  }

  onChatMessage(peerId, message) {
    this.pushChatMessage(peerId, {
      id: message.message_id || makeId(),
      direction: "incoming",
      peerName: this.app.getPeerName(peerId),
      text: message.text || "",
      timestamp: Number(message.sent_at) || Date.now(),
    })
    notifyIfHidden(`${this.app.getPeerName(peerId)} · 新消息`, message.text || "")
    if (this.app.state.selectedPeerId !== peerId) {
      this.app.state.unreadMessages.set(peerId, this.app.getUnreadCount(peerId) + 1)
      this.app.appendLog(`${this.app.getPeerName(peerId)} 发来了一条新消息。`, "info")
      return
    }
    this.app.notify()
  }
}

function guessMimeFromName(name) {
  const ext = String(name || "").split(".").pop().toLowerCase()
  const table = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    txt: "text/plain",
    pdf: "application/pdf",
    zip: "application/zip",
    json: "application/json",
    mp4: "video/mp4",
    mp3: "audio/mpeg",
  }
  return table[ext] || ""
}

function isImageAttachment(mime, name) {
  if (String(mime || "").startsWith("image/")) {
    return true
  }
  return Boolean(guessMimeFromName(name).startsWith("image/"))
}

function formatBytesLabel(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  }
  return `${Math.max(Math.round(bytes / 1024), 1)}KB`
}
