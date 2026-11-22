import {
  CHUNK_SIZE,
  RELAY_MAX_TRANSFER_BYTES,
  SESSION_RECEIVE_ACK_TIMEOUT_MS,
} from "../constants.js"
import { makeId } from "../utils/id.js"
import { stripFileHandle, calculateIncomingProgress, objectToSets } from "../protocol/messages.js"
import { TransferCancelledError } from "../protocol/errors.js"
import { arrayBufferToBase64 } from "../utils/base64.js"
import { hashFile } from "../utils/crypto.js"
import { delay, waitForBufferedAmount, waitForChannelOpen } from "../utils/webrtc.js"
import { formatBytes } from "../utils/format.js"

// 发送侧：多设备请求发起、分块流水线（直连/中继）、接收确认（ack）、取消与续传。
export class SenderController {
  constructor(app) {
    this.app = app
  }

  ensureReceiverAckPromise(session) {
    if (!session) {
      return Promise.resolve({ acknowledged: false, missing: true })
    }
    if (!session.receiverAckPromise) {
      session.receiverAckPromise = new Promise((resolve) => {
        session.resolveReceiverAck = resolve
      })
    }
    return session.receiverAckPromise
  }

  settleReceiverAck(session, result) {
    if (!session || !session.resolveReceiverAck) {
      return
    }
    session.resolveReceiverAck(result)
    session.resolveReceiverAck = null
  }

  async waitForReceiverCompletion(session) {
    if (!session) {
      return { acknowledged: false, missing: true }
    }
    if (session.receiverAckWaitPromise) {
      return session.receiverAckWaitPromise
    }

    session.awaitingReceiverAck = true
    const ackPromise = this.ensureReceiverAckPromise(session)
    session.receiverAckWaitPromise = (async () => {
      const result = await Promise.race([
        ackPromise,
        delay(SESSION_RECEIVE_ACK_TIMEOUT_MS).then(() => ({ acknowledged: false, timeout: true })),
      ])
      if (result && result.timeout) {
        this.settleReceiverAck(session, result)
      }
      return result
    })()

    try {
      return await session.receiverAckWaitPromise
    } finally {
      session.awaitingReceiverAck = false
      session.receiverAckWaitPromise = null
      session.receiverAckPromise = null
      session.resolveReceiverAck = null
    }
  }

  async waitForPendingReceiverAcks() {
    const sessions = Array.from(this.app.state.outgoingSessions.values()).filter(
      (session) => session.awaitingReceiverAck || session.receiverAckWaitPromise
    )
    if (!sessions.length) {
      return
    }
    this.app.appendLog("Closing is delayed until the receiver finishes the final save step.", "info")
    await Promise.allSettled(sessions.map((session) => this.app.waitForReceiverCompletion(session)))
  }

  updateOutgoingTransferStatus(session) {
    if (!session) {
      return
    }
    const total = session.totalSize || 0
    const remoteReceivedBytes = Math.min(session.remoteReceivedBytes || 0, total)
    if (session.awaitingReceiverAck && remoteReceivedBytes >= total) {
      this.app.setTransferStatus(`Waiting for ${session.peerName} to finish receiving`, total, total)
      return
    }
    this.app.setTransferStatus(
      `${session.transport === "relay" ? "中继发送到" : "发送到"} ${session.peerName} · 对端已接收`,
      remoteReceivedBytes,
      total
    )
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
    this.settleReceiverAck(session, {
      acknowledged: false,
      cancelled: true,
      reason,
    })
    await this.app.updateSessionRecord(session.sessionId, {
      status: "cancelled",
      updatedAt: Date.now(),
      completedAt: null,
      errorMessage: reason,
    })
    this.app.state.outgoingSessions.delete(session.sessionId)
    this.app.clearTransferStatus()
    await this.app.refreshHistory()
    this.app.notify()
  }

  async startTransferRequest() {
    try {
      const selectedPeerIds = this.app.getSelectedTransferPeerIds()
      if (!selectedPeerIds.length) {
        this.app.appendLog("先在房间设备列表里选择至少一个发送对象。", "warn")
        return false
      }
      if (!this.app.state.selectedFiles.length) {
        this.app.appendLog("先选择要发送的文件。", "warn")
        return false
      }
      if (!this.app.options.allowMultipleFiles && this.app.state.selectedFiles.length > 1) {
        this.app.appendLog("当前设备只支持发送单个文件。", "warn")
        return false
      }

      this.app.setTransferStatus("准备中", 0, 0)

      const fileBlueprints = []
      let totalSize = 0
      for (const item of this.app.state.selectedFiles) {
        const sha256 = await hashFile(item.file)
        const chunkCount = Math.max(Math.ceil(item.file.size / CHUNK_SIZE), 1)
        fileBlueprints.push({
          relative_path: item.relativePath,
          size: item.file.size,
          sha256,
          chunk_size: CHUNK_SIZE,
          chunk_count: chunkCount,
          file: item.file,
        })
        totalSize += item.file.size
      }
      let createdCount = 0
      for (const peerId of selectedPeerIds) {
        const connection = this.app.getOpenConnection(peerId)
        const transportPreference = connection ? "p2p" : "relay"
        const peerName = this.app.getPeerName(peerId)

        if (!connection && this.app.state.selectedFiles.length > 1) {
          this.app.appendLog(`${peerName} 当前未建立直连，多文件发送已跳过。`, "warn")
          continue
        }
        if (transportPreference === "relay" && totalSize > RELAY_MAX_TRANSFER_BYTES) {
          this.app.appendLog(
            `${peerName} 当前只能通过中继接收，${formatBytes(totalSize)} 超过 ${formatBytes(RELAY_MAX_TRANSFER_BYTES)} 限制，已跳过。`,
            "warn"
          )
          continue
        }
        if (!connection) {
          this.app.appendLog(`将通过中继向 ${peerName} 发送文件。`, "info")
        }

        const sessionId = makeId()
        const createdAt = Date.now()
        const files = fileBlueprints.map((fileMeta) => ({
          ...fileMeta,
          file_id: makeId(),
        }))
        const session = {
          sessionId,
          peerClientId: peerId,
          peerName,
          files,
          totalSize,
          sentBytes: 0,
          sending: false,
          accepted: false,
          transport: transportPreference,
          createdAt,
          cancelRequested: false,
          cancelReason: "",
          remoteReceivedBytes: 0,
          awaitingReceiverAck: false,
          receiverAckPromise: null,
          receiverAckWaitPromise: null,
          resolveReceiverAck: null,
        }
        this.app.state.outgoingSessions.set(sessionId, session)

        await this.app.upsertSessionRecord({
          sessionId,
          direction: "outgoing",
          status: "waiting",
          roomCode: this.app.state.roomCode,
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

        this.app.sendSignal({
          type: "transfer_request",
          target_client_id: peerId,
          session_id: sessionId,
          total_size: totalSize,
          files: files.map(stripFileHandle),
          transport_preference: transportPreference,
        })
        createdCount += 1
      }

      if (!createdCount) {
        this.app.appendLog("当前所选设备都不满足发送条件，请等待直连或调整文件选择。", "warn")
        return false
      }

      this.app.appendLog(
        createdCount === 1 ? "已向 1 台设备发起传输请求。" : `已向 ${createdCount} 台设备发起传输请求。`,
        "info"
      )
      await this.app.refreshHistory()
      return true
    } catch (error) {
      this.app.appendLog(`准备传输失败: ${error.message}`, "danger")
      return false
    } finally {
      if (!this.app.state.transferStatus || this.app.state.transferStatus.label === "准备中") {
        this.app.clearTransferStatus()
      }
    }
  }

  async cancelOutgoingSession(sessionId, reason = "The sender cancelled the transfer.") {
    const session = this.app.state.outgoingSessions.get(sessionId)
    if (!session) {
      return false
    }

    if (session.accepted || session.sending) {
      session.cancelRequested = true
      session.cancelReason = reason
      this.settleReceiverAck(session, {
        acknowledged: false,
        cancelled: true,
        reason,
      })
      if (this.app.isConnected()) {
        this.app.sendSignal({
          type: "transfer_abort",
          target_client_id: session.peerClientId,
          session_id: sessionId,
          reason,
        })
      }
      this.app.appendLog(
        session.sending ? `Stopping transfer to ${session.peerName}.` : `Cancelled transfer to ${session.peerName}.`,
        "warn"
      )
      if (!session.sending) {
        await this.finalizeOutgoingCancellation(session, reason)
      }
      this.app.notify()
      return true
    }

    if (this.app.isConnected()) {
      this.app.sendSignal({
        type: "transfer_cancel",
        target_client_id: session.peerClientId,
        session_id: sessionId,
        reason,
      })
    }
    await this.finalizeOutgoingCancellation(session, reason)
    return true
  }

  async onTransferAccept(message) {
    const session = this.app.state.outgoingSessions.get(message.session_id)
    if (!session) {
      return
    }
    session.accepted = true
    session.transport = message.transport || session.transport || "p2p"
    this.app.appendLog(`${session.peerName} 已确认接收（${session.transport === "relay" ? "中继" : "直连"}）。`, "info")
    await this.app.updateSessionRecord(message.session_id, {
      status: "accepted",
      updatedAt: Date.now(),
    })
    await this.app.refreshHistory()
    if (session.transport === "relay") {
      await this.sendOutgoingSession(session, new Map())
    }
  }

  async onTransferReject(message) {
    const session = this.app.state.outgoingSessions.get(message.session_id)
    if (!session) {
      return
    }
    const reason = String(message.reason || "").trim()
    if (reason) {
      this.app.appendLog(`${session.peerName} rejected the transfer: ${reason}`, "warn")
      await this.app.updateSessionRecord(message.session_id, {
        status: "rejected",
        updatedAt: Date.now(),
        errorMessage: reason,
      })
      this.app.state.outgoingSessions.delete(message.session_id)
      await this.app.refreshHistory()
      return
    }
    this.app.appendLog(`${session.peerName} 已拒绝接收。`, "warn")
    await this.app.updateSessionRecord(message.session_id, {
      status: "rejected",
      updatedAt: Date.now(),
      errorMessage: null,
    })
    this.app.state.outgoingSessions.delete(message.session_id)
    await this.app.refreshHistory()
  }

  async onTransferCancel(message) {
    const reason = String(message.reason || "").trim() || "The sender cancelled the transfer."
    const outgoingSession = this.app.state.outgoingSessions.get(message.session_id)
    if (outgoingSession) {
      await this.finalizeOutgoingCancellation(outgoingSession, reason)
      return
    }

    if (
      this.app.state.pendingIncomingRequests.has(message.session_id) ||
      this.app.incomingChunkState.has(message.session_id) ||
      (await this.app.getSessionRecord(message.session_id))
    ) {
      await this.app.cancelIncomingSession(message.session_id, reason, false)
    }
  }

  async onTransferAbort(message) {
    const reason = String(message.reason || "").trim() || "The other side stopped the transfer."
    const outgoingSession = this.app.state.outgoingSessions.get(message.session_id)
    if (outgoingSession) {
      outgoingSession.cancelRequested = true
      outgoingSession.cancelReason = reason
      this.settleReceiverAck(outgoingSession, {
        acknowledged: false,
        cancelled: true,
        reason,
      })
      this.app.appendLog(reason, "warn")
      if (!outgoingSession.sending) {
        await this.finalizeOutgoingCancellation(outgoingSession, reason)
      }
      return
    }

    await this.app.cancelIncomingSession(message.session_id, reason, false)
  }

  async onResumeRequest(message) {
    const session = this.app.state.outgoingSessions.get(message.session_id)
    if (!session) {
      this.app.appendLog(`恢复请求找不到发送会话 ${message.session_id}。`, "warn")
      return
    }
    this.app.sendSignal({
      type: "transfer_request",
      target_client_id: message.from_client_id,
      session_id: session.sessionId,
      total_size: session.totalSize,
      files: session.files.map(stripFileHandle),
    })
  }

  async onResumeState(message) {
    const session = this.app.state.outgoingSessions.get(message.session_id)
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
    const connection = transport === "p2p" ? this.app.getOpenConnection(session.peerClientId) : null
    if (transport === "p2p" && !connection) {
      throw new Error(`设备 ${session.peerName} 的传输通道未就绪。`)
    }
    if (connection && connection.sendingSessionId && connection.sendingSessionId !== session.sessionId) {
      this.app.appendLog(`${session.peerName} 当前已有其他传输进行中。`, "warn")
      return
    }

    session.sending = true
    session.sentBytes = 0
    session.remoteReceivedBytes = calculateIncomingProgress(
      session.files,
      Object.fromEntries(Array.from(completedMap.entries()).map(([fileId, set]) => [fileId, set]))
    ).done
    if (connection) {
      connection.sendingSessionId = session.sessionId
    }

    try {
      if (transport === "p2p") {
        await waitForChannelOpen(connection)
      }
      this.assertSessionNotCancelled(session)
      await this.app.updateSessionRecord(session.sessionId, {
        status: "sending",
        updatedAt: Date.now(),
      })
      this.updateOutgoingTransferStatus(session)

      await this.app.sendTransferControl(session.peerClientId, transport, connection, {
        type: "session_start",
        session_id: session.sessionId,
        total_size: session.totalSize,
        file_count: session.files.length,
      })

      for (const fileMeta of session.files) {
        this.assertSessionNotCancelled(session)
        const completedChunks = completedMap.has(fileMeta.file_id) ? completedMap.get(fileMeta.file_id) : new Set()
        await this.app.sendTransferControl(session.peerClientId, transport, connection, {
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
            this.updateOutgoingTransferStatus(session)
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
            this.app.sendDataControl(connection.channel, header)
            await waitForBufferedAmount(connection.channel, buffer.byteLength)
            this.assertSessionNotCancelled(session)
            connection.channel.send(buffer)
          } else {
            this.app.sendRelayPayload(session.peerClientId, {
              relay_type: "control",
              payload: header,
            })
            this.app.sendRelayPayload(session.peerClientId, {
              relay_type: "binary",
              header,
              data_b64: arrayBufferToBase64(buffer),
            })
          }
          session.sentBytes += buffer.byteLength
          this.updateOutgoingTransferStatus(session)
        }

        await this.app.sendTransferControl(session.peerClientId, transport, connection, {
          type: "file_end",
          session_id: session.sessionId,
          file_id: fileMeta.file_id,
          sha256: fileMeta.sha256,
        })
      }

      await this.app.sendTransferControl(session.peerClientId, transport, connection, {
        type: "session_complete",
        session_id: session.sessionId,
      })
      this.app.appendLog(`Data send finished. Waiting for ${session.peerName} to confirm receipt.`, "info")
      this.app.setTransferStatus(`Waiting for ${session.peerName} to finish receiving`, session.totalSize, session.totalSize)
      const receipt = await this.app.waitForReceiverCompletion(session)
      if (receipt && receipt.acknowledged) {
        this.app.appendLog(`${session.peerName} confirmed that the receive side has finished saving.`, "info")
      } else {
        this.app.appendLog(
          `No receive confirmation arrived within ${Math.round(SESSION_RECEIVE_ACK_TIMEOUT_MS / 1000)} seconds. The channel can now close safely.`,
          "warn"
        )
      }

      this.app.appendLog(`发送完成: ${session.peerName}。`, "info")
      await this.app.updateSessionRecord(session.sessionId, {
        status: "completed",
        updatedAt: Date.now(),
        completedAt: Date.now(),
      })
      this.app.state.outgoingSessions.delete(session.sessionId)
      await this.app.refreshHistory()
    } catch (error) {
      if (error instanceof TransferCancelledError) {
        await this.finalizeOutgoingCancellation(session, error.message)
        return
      }
      this.app.appendLog(`发送中断: ${error.message}`, "danger")
      await this.app.updateSessionRecord(session.sessionId, {
        status: "pending",
        updatedAt: Date.now(),
      })
      await this.app.refreshHistory()
    } finally {
      session.sending = false
      if (connection) {
        connection.sendingSessionId = null
      }
      this.app.clearTransferStatus()
    }
  }

  onSessionReceived(message) {
    const session = this.app.state.outgoingSessions.get(message.session_id)
    if (!session) {
      return
    }
    session.remoteReceivedBytes = session.totalSize || session.remoteReceivedBytes || 0
    this.settleReceiverAck(session, {
      acknowledged: true,
      sessionId: message.session_id,
    })
  }

  onSessionProgress(message) {
    const session = this.app.state.outgoingSessions.get(message.session_id)
    if (!session) {
      return
    }
    const receivedBytes = Math.max(0, Number(message.received_bytes) || 0)
    session.remoteReceivedBytes = Math.max(session.remoteReceivedBytes || 0, receivedBytes)
    if (session.sending || session.awaitingReceiverAck) {
      this.updateOutgoingTransferStatus(session)
    }
  }

  // 发送端断点续传第一步：发现 IndexedDB 里未完成的发送会话（对端在线时展示恢复卡片）。
  // 每次全量重算：房间一致、对端在线、尚未在活动会话中的记录才会展示。
  async resumePendingOutgoing() {
    if (!this.app.options.enableResume || !this.app.isConnected()) {
      return
    }
    const found = new Map()
    for (const status of ["waiting", "pending", "sending", "accepted"]) {
      const records = await this.app.listSessionsByStatus(status)
      for (const record of records) {
        if (record.direction !== "outgoing" || found.has(record.sessionId)) {
          continue
        }
        if (record.roomCode !== this.app.state.roomCode) {
          continue
        }
        if (this.app.state.outgoingSessions.has(record.sessionId)) {
          continue
        }
        if (!this.app.state.peers.has(record.peerClientId)) {
          continue
        }
        const progress = calculateIncomingProgress(record.filesMeta || [], objectToSets(record.completedChunks))
        found.set(record.sessionId, { record, done: progress.done, total: progress.total })
      }
    }

    const previous = this.app.state.pendingOutgoingResumes
    const changed =
      previous.size !== found.size ||
      Array.from(found.keys()).some((sessionId) => !previous.has(sessionId))
    this.app.state.pendingOutgoingResumes = found
    if (changed) {
      this.app.notify()
    }
  }

  // 发送端断点续传第二步：用户重新选择文件后，按路径+大小匹配并做哈希验证，
  // 复用同一 sessionId 重发 transfer_request，接收端接受后回 resume_state 跳过已收分块。
  async completeOutgoingResume(sessionId, collectedFiles) {
    const entry = this.app.state.pendingOutgoingResumes.get(sessionId)
    const record = entry ? entry.record : await this.app.getSessionRecord(sessionId)
    if (!record || record.direction !== "outgoing") {
      return false
    }
    const metaList = Array.isArray(record.filesMeta) ? record.filesMeta : []
    if (!metaList.length) {
      return false
    }

    const pool = collectedFiles.map((item) => ({ item, used: false }))
    const files = []
    for (const fileMeta of metaList) {
      const match = pool.find(
        (candidate) =>
          !candidate.used &&
          candidate.item.relativePath === fileMeta.relative_path &&
          candidate.item.file.size === fileMeta.size
      )
      if (!match) {
        this.app.appendLog(
          `文件不匹配: ${fileMeta.relative_path}（需要相对路径与大小完全一致，文件夹请整个重选）`,
          "warn"
        )
        return false
      }
      match.used = true
      files.push({ ...fileMeta, file: match.item.file })
    }

    this.app.setTransferStatus("校验待续传文件", 0, 0)
    try {
      for (const file of files) {
        const sha256 = await hashFile(file.file)
        if (sha256 !== file.sha256) {
          this.app.appendLog(`文件内容与上次发送不一致: ${file.relative_path}`, "warn")
          return false
        }
      }
    } finally {
      this.app.clearTransferStatus()
    }

    const peerId = record.peerClientId
    const connection = this.app.getOpenConnection(peerId)
    const transport = connection ? "p2p" : "relay"
    if (transport === "relay" && record.totalSize > RELAY_MAX_TRANSFER_BYTES) {
      this.app.appendLog(
        `${sessionPeerName(record)} 只能通过中继接收，超过 ${formatBytes(RELAY_MAX_TRANSFER_BYTES)} 上限，无法续传。`,
        "warn"
      )
      return false
    }

    const session = {
      sessionId,
      peerClientId: peerId,
      peerName: record.peerName || this.app.getPeerName(peerId),
      files,
      totalSize: record.totalSize,
      sentBytes: 0,
      sending: false,
      accepted: false,
      transport,
      createdAt: Date.now(),
      cancelRequested: false,
      cancelReason: "",
      remoteReceivedBytes: 0,
      awaitingReceiverAck: false,
      receiverAckPromise: null,
      receiverAckWaitPromise: null,
      resolveReceiverAck: null,
    }
    this.app.state.outgoingSessions.set(sessionId, session)
    this.app.state.pendingOutgoingResumes.delete(sessionId)
    // 状态保持 sending/pending（不降级为 waiting）：接收端靠它识别“可续传”。
    await this.app.updateSessionRecord(sessionId, {
      updatedAt: Date.now(),
      completedAt: null,
      errorMessage: null,
    })
    this.app.sendSignal({
      type: "transfer_request",
      target_client_id: peerId,
      session_id: sessionId,
      total_size: record.totalSize,
      files: files.map(stripFileHandle),
      transport_preference: transport,
    })
    this.app.appendLog(`已向 ${session.peerName} 请求继续上次的传输。`, "info")
    await this.app.refreshHistory()
    return true
  }
}

function sessionPeerName(record) {
  return (record && record.peerName) || "对端"
}
