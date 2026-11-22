import {
  INCOMING_SESSION_FLUSH_BATCH_SIZE,
  INCOMING_SESSION_FLUSH_INTERVAL_MS,
  IOS_SAFARI_MAX_INCOMING_BYTES,
  MOBILE_SKIP_CHECKSUM_BYTES,
  RELAY_MAX_TRANSFER_BYTES,
  SESSION_PROGRESS_BATCH_SIZE,
} from "../constants.js"
import { calculateIncomingProgress, isTerminalSessionStatus, objectToSets, setsToObject } from "../protocol/messages.js"
import { downloadBlob } from "../utils/files.js"
import { hashBlob } from "../utils/crypto.js"
import { createStoredZip } from "../utils/zip.js"
import { makeChunkKey } from "../utils/id.js"
import { notifyIfHidden } from "../utils/notify.js"

// 接收侧：传输请求确认、分块落盘（IndexedDB）、校验与保存、断点续传请求。
export class ReceiverController {
  constructor(app) {
    this.app = app
  }

  shouldAvoidRelayForSize(totalSize) {
    return totalSize > RELAY_MAX_TRANSFER_BYTES
  }

  shouldBlockIncomingTransfer(totalSize, transportPreference) {
    if (!this.app.runtime.isIOSWebKitBrowser) {
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
    let chunkState = this.app.incomingChunkState.get(session.sessionId)
    if (!chunkState) {
      const initialProgress = calculateIncomingProgress(session.filesMeta || [], objectToSets(session.completedChunks))
      chunkState = {
        sessionId: session.sessionId,
        peerClientId: session.peerClientId || "",
        filesMeta: Array.from(session.filesMeta || []),
        peerName: session.peerName || "",
        completedSets: objectToSets(session.completedChunks),
        dirtyCount: 0,
        createdAt: session.createdAt || Date.now(),
        lastSessionFlushAt: Date.now(),
        lastReportedBytes: initialProgress.done,
        pendingProgressCount: 0,
        lastProgressSentAt: 0,
      }
      this.app.incomingChunkState.set(session.sessionId, chunkState)
    }
    return chunkState
  }

  async flushIncomingChunkState(sessionId, patch = {}) {
    const chunkState = this.app.incomingChunkState.get(sessionId)
    if (!chunkState) {
      if (Object.keys(patch).length) {
        await this.app.updateSessionRecord(sessionId, patch)
      }
      return
    }
    chunkState.dirtyCount = 0
    chunkState.lastSessionFlushAt = Date.now()
    await this.app.updateSessionRecord(sessionId, {
      completedChunks: setsToObject(chunkState.completedSets),
      updatedAt: Date.now(),
      ...patch,
    })
  }

  clearIncomingChunkState(sessionId) {
    this.app.incomingChunkState.delete(sessionId)
  }

  async sendIncomingProgress(chunkState, done, total, force = false) {
    if (!chunkState || !chunkState.peerClientId) {
      return false
    }
    const now = Date.now()
    chunkState.pendingProgressCount = (chunkState.pendingProgressCount || 0) + 1
    const isFirstReport = !chunkState.lastProgressSentAt
    const shouldReport =
      force ||
      isFirstReport ||
      chunkState.pendingProgressCount >= SESSION_PROGRESS_BATCH_SIZE ||
      now - chunkState.lastProgressSentAt >= 200

    if (!shouldReport) {
      return false
    }

    const payload = {
      type: "session_progress",
      session_id: chunkState.sessionId,
      received_bytes: done,
      total_size: total,
    }
    // 进度回报同样以 ackTarget（真实发送方）为准
    const progressTarget = chunkState.ackTarget || chunkState.peerClientId
    const transport = this.app.getOpenConnection(progressTarget) ? "p2p" : "relay"

    try {
      if (transport === "p2p") {
        const connection = this.app.getOpenConnection(progressTarget)
        if (!connection) {
          return false
        }
        await this.app.sendTransferControl(progressTarget, "p2p", connection, payload)
      } else {
        if (!this.app.isConnected()) {
          return false
        }
        await this.app.sendTransferControl(progressTarget, "relay", null, payload)
      }
      chunkState.lastReportedBytes = done
      chunkState.pendingProgressCount = 0
      chunkState.lastProgressSentAt = now
      return true
    } catch (error) {
      void error
      return false
    }
  }

  async sendIncomingSessionAck(sessionId, ackTargetHint = null) {
    const chunkState = this.app.incomingChunkState.get(sessionId)
    const session = await this.app.getSessionRecord(sessionId)
    const target = ackTargetHint || (chunkState && chunkState.ackTarget) || (session && session.peerClientId)
    if (!target) {
      return false
    }

    const payload = {
      type: "session_received",
      session_id: sessionId,
    }
    const preferredTransport = session?.transport || (this.app.getOpenConnection(target) ? "p2p" : "relay")
    const transports = preferredTransport === "p2p" ? ["p2p", "relay"] : ["relay", "p2p"]

    for (const transport of transports) {
      try {
        if (transport === "p2p") {
          const connection = this.app.getOpenConnection(target)
          if (!connection) {
            continue
          }
          await this.app.sendTransferControl(target, "p2p", connection, payload)
          return true
        }
        if (!this.app.isConnected()) {
          continue
        }
        await this.app.sendTransferControl(target, "relay", null, payload)
        return true
      } catch (error) {
        void error
      }
    }

    return false
  }

  async onTransferRequest(message) {
    const incomingFiles = Array.from(message.files || [])
    const isSingleTopLevelFile =
      incomingFiles.length === 1 && !String(incomingFiles[0].relative_path || "").includes("/")

    if (!this.app.options.allowIncomingMultiFile && !isSingleTopLevelFile) {
      this.app.appendLog("当前设备仅支持接收单文件，请切换电脑端接收。", "warn")
      this.app.sendSignal({
        type: "transfer_reject",
        target_client_id: message.from_client_id,
        session_id: message.session_id,
        reason: "This device only accepts a single top-level file in the current view.",
      })
      await this.upsertRejectedSessionRecord(message, incomingFiles)
      return
    }

    const peerName = this.app.getPeerName(message.from_client_id)
    const existing = await this.app.getSessionRecord(message.session_id)
    const blockReason = this.shouldBlockIncomingTransfer(
      Number(message.total_size) || 0,
      message.transport_preference || "p2p"
    )
    if (blockReason) {
      this.app.appendLog(blockReason, "warn")
      this.app.sendSignal({
        type: "transfer_reject",
        target_client_id: message.from_client_id,
        session_id: message.session_id,
        reason: blockReason,
      })
      await this.upsertRejectedSessionRecord(message, incomingFiles)
      return
    }
    this.app.state.pendingIncomingRequests.set(message.session_id, {
      sessionId: message.session_id,
      fromClientId: message.from_client_id,
      peerName,
      files: incomingFiles,
      totalSize: message.total_size,
      // 记录处于接收中/已接受/待处理都算可续传（发送方刷新后重发同一会话）
      isResume: Boolean(existing && ["pending", "accepted", "sending"].includes(existing.status)),
      transportPreference: message.transport_preference || "p2p",
    })
    this.app.appendLog(`${peerName} 请求发送 ${incomingFiles.length} 个项目。`, "info")
    notifyIfHidden(`${peerName} · 传输请求`, `${incomingFiles.length} 个文件等待你确认`)
    this.app.notify()
  }

  async upsertRejectedSessionRecord(message, incomingFiles) {
    await this.app.upsertSessionRecord({
      sessionId: message.session_id,
      direction: "incoming",
      status: "rejected",
      roomCode: this.app.state.roomCode,
      peerClientId: message.from_client_id,
      peerName: this.app.getPeerName(message.from_client_id),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null,
      fileCount: incomingFiles.length,
      totalSize: message.total_size,
      filesMeta: incomingFiles,
      completedChunks: {},
    })
    await this.app.refreshHistory()
  }

  async acceptIncomingTransfer(sessionId) {
    const request = this.app.state.pendingIncomingRequests.get(sessionId)
    if (!request) {
      return
    }
    const transport =
      request.transportPreference === "relay" || !this.app.getOpenConnection(request.fromClientId) ? "relay" : "p2p"

    let session = await this.app.getSessionRecord(sessionId)
    if (!session) {
      session = {
        sessionId,
        direction: "incoming",
        status: "pending",
        roomCode: this.app.state.roomCode,
        peerClientId: request.fromClientId,
        peerName: request.peerName,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        completedAt: null,
        fileCount: request.files.length,
        totalSize: request.totalSize,
        filesMeta: request.files,
        completedChunks: {},
        transport,
      }
    } else if (session.direction === "incoming") {
      // 只更新自己视角的接收记录。同一浏览器多标签页时（共享 IndexedDB），
      // 可能读到发送方的 outgoing 记录——此时不能改写它的归属字段。
      session = {
        ...session,
        status: "pending",
        updatedAt: Date.now(),
        peerClientId: request.fromClientId,
        peerName: request.peerName,
        filesMeta: request.files,
        fileCount: request.files.length,
        totalSize: request.totalSize,
        transport,
      }
    } else {
      // 记录属于发送方（共享 IndexedDB 的另一标签页）：只刷新状态，保留其归属。
      session = {
        ...session,
        status: "pending",
        updatedAt: Date.now(),
      }
    }

    await this.app.upsertSessionRecord(session)
    const chunkState = this.ensureIncomingChunkState(session)
    // 记录真实发送方：共享 IndexedDB（同浏览器多标签页）时记录字段可能属于发送方，
    // ack/进度回报必须以接受请求时的对端为准。
    chunkState.ackTarget = request.fromClientId
    this.app.sendSignal({
      type: "transfer_accept",
      target_client_id: request.fromClientId,
      session_id: sessionId,
      transport,
    })
    if (transport === "p2p") {
      this.app.sendSignal({
        type: "resume_state",
        target_client_id: request.fromClientId,
        session_id: sessionId,
        files: request.files.map((file) => ({
          file_id: file.file_id,
          completed_chunks: ((session.completedChunks && session.completedChunks[file.file_id]) || []).slice(),
        })),
      })
    }

    this.app.state.pendingIncomingRequests.delete(sessionId)
    this.app.appendLog(`已接受 ${request.peerName} 的传输请求（${transport === "relay" ? "中继" : "直连"}）。`, "info")
    await this.app.refreshHistory()
    this.app.notify()
  }

  async rejectIncomingTransfer(sessionId) {
    const request = this.app.state.pendingIncomingRequests.get(sessionId)
    if (!request) {
      return
    }

    this.app.sendSignal({
      type: "transfer_reject",
      target_client_id: request.fromClientId,
      session_id: sessionId,
      reason: "The receiver rejected the transfer.",
    })
    await this.app.upsertSessionRecord({
      sessionId,
      direction: "incoming",
      status: "rejected",
      roomCode: this.app.state.roomCode,
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

    this.app.state.pendingIncomingRequests.delete(sessionId)
    this.clearIncomingChunkState(sessionId)
    await this.app.refreshHistory()
    this.app.notify()
  }

  async cancelIncomingSession(sessionId, reason = "The receiver cancelled the transfer.", notifyPeer = false) {
    const request = this.app.state.pendingIncomingRequests.get(sessionId) || null
    const chunkState = this.app.incomingChunkState.get(sessionId) || null
    const session = await this.app.getSessionRecord(sessionId)
    if (session && ["completed", "rejected", "cancelled"].includes(session.status)) {
      return false
    }
    const peerClientId = request?.fromClientId || chunkState?.peerClientId || session?.peerClientId || null
    const peerName = request?.peerName || chunkState?.peerName || session?.peerName || ""

    if (notifyPeer && peerClientId && this.app.isConnected()) {
      this.app.sendSignal({
        type: "transfer_abort",
        target_client_id: peerClientId,
        session_id: sessionId,
        reason,
      })
    }

    this.app.state.pendingIncomingRequests.delete(sessionId)
    await this.app.clearChunksBySession(sessionId)
    this.clearIncomingChunkState(sessionId)

    if (session) {
      await this.app.updateSessionRecord(sessionId, {
        status: "cancelled",
        updatedAt: Date.now(),
        completedAt: null,
        errorMessage: reason,
      })
    } else if (request) {
      await this.app.upsertSessionRecord({
        sessionId,
        direction: "incoming",
        status: "cancelled",
        roomCode: this.app.state.roomCode,
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
      this.app.appendLog(`${peerName} transfer cancelled.`, "warn")
    }
    this.app.clearTransferStatus()
    await this.app.refreshHistory()
    this.app.notify()
    return true
  }

  async storeIncomingChunk(header, buffer) {
    const session = await this.app.getSessionRecord(header.session_id)
    if (!session) {
      return
    }
    if (isTerminalSessionStatus(session.status)) {
      return
    }

    const chunkState = this.ensureIncomingChunkState(session)
    const completed = chunkState.completedSets
    const fileSet = completed[header.file_id] || new Set()
    if (fileSet.has(header.chunk_index)) {
      return
    }

    await this.app.putChunk({
      chunkKey: makeChunkKey(header.session_id, header.file_id, header.chunk_index),
      sessionId: header.session_id,
      fileId: header.file_id,
      chunkIndex: header.chunk_index,
      data: buffer,
    })

    fileSet.add(header.chunk_index)
    completed[header.file_id] = fileSet
    chunkState.dirtyCount = (chunkState.dirtyCount || 0) + 1
    const now = Date.now()
    const shouldFlushSession =
      chunkState.dirtyCount >= INCOMING_SESSION_FLUSH_BATCH_SIZE ||
      now - (chunkState.lastSessionFlushAt || 0) >= INCOMING_SESSION_FLUSH_INTERVAL_MS
    if (shouldFlushSession) {
      await this.flushIncomingChunkState(header.session_id, { status: "pending" })
    }

    const progress = calculateIncomingProgress(chunkState.filesMeta, completed)
    this.app.setTransferStatus(`Receiving from ${chunkState.peerName || session.peerName}`, progress.done, progress.total)
    await this.app.sendIncomingProgress(chunkState, progress.done, progress.total)
    return
  }

  shouldSkipChecksum(fileMeta) {
    return Boolean(this.app.runtime.isMobileBrowser && fileMeta && fileMeta.size > MOBILE_SKIP_CHECKSUM_BYTES)
  }

  async finalizeIncomingFile(message) {
    const session = await this.app.getSessionRecord(message.session_id)
    if (!session) {
      return
    }
    if (isTerminalSessionStatus(session.status)) {
      return
    }
    await this.flushIncomingChunkState(message.session_id, { status: "pending" })
    const fileMeta = session.filesMeta.find((item) => item.file_id === message.file_id)
    if (!fileMeta) {
      return
    }

    if (this.shouldSkipChecksum(fileMeta)) {
      this.app.appendLog(`Skipping full checksum on mobile for large file: ${fileMeta.relative_path}`, "warn")
      return
    }

    const blob = await this.app.buildBlobFromChunks(message.session_id, fileMeta.file_id)
    const checksum = await hashBlob(blob)
    if (checksum !== fileMeta.sha256) {
      this.app.appendLog(`文件校验失败: ${fileMeta.relative_path}`, "danger")
      await this.flushIncomingChunkState(message.session_id, {
        status: "failed",
        completedAt: null,
      })
      this.clearIncomingChunkState(message.session_id)
      await this.app.refreshHistory()
      return
    }
    this.app.appendLog(`文件校验通过: ${fileMeta.relative_path}`, "info")
  }

  async finalizeIncomingSession(sessionId) {
    const session = await this.app.getSessionRecord(sessionId)
    if (!session) {
      return
    }
    if (session.status === "failed") {
      this.app.appendLog(`会话 ${sessionId.slice(0, 8)} 校验失败，已停止保存。`, "danger")
      return
    }
    if (isTerminalSessionStatus(session.status)) {
      return
    }
    await this.flushIncomingChunkState(sessionId, { status: "pending" })

    try {
      if (session.filesMeta.length === 1 && !session.filesMeta[0].relative_path.includes("/")) {
        const fileMeta = session.filesMeta[0]
        const blob = await this.app.buildBlobFromChunks(sessionId, fileMeta.file_id)
        downloadBlob(blob, fileMeta.relative_path)
      } else if (this.app.options.allowIncomingMultiFile) {
        const files = []
        for (const fileMeta of session.filesMeta) {
          const blob = await this.app.buildBlobFromChunks(sessionId, fileMeta.file_id)
          files.push({
            name: fileMeta.relative_path,
            bytes: new Uint8Array(await blob.arrayBuffer()),
          })
        }
        downloadBlob(createStoredZip(files), `transfer-${sessionId.slice(0, 8)}.zip`)
      } else {
        throw new Error("当前设备仅支持接收单文件。")
      }
    } catch (error) {
      this.app.appendLog(`接收完成但保存失败: ${error.message}`, "danger")
      return
    }

    await this.flushIncomingChunkState(sessionId, {
      status: "completed",
      completedAt: Date.now(),
    })
    await this.sendIncomingProgress(
      this.ensureIncomingChunkState(session),
      session.totalSize || 0,
      session.totalSize || 0,
      true
    )
    // 清理前先捕获 ack 目标（清理后 chunkState 不在了，共享 IndexedDB 时
    // 记录里的 peerClientId 可能指向自己而非发送方）。
    const ackTarget = this.app.incomingChunkState.get(sessionId)?.ackTarget || null
    await this.app.clearChunksBySession(sessionId)
    this.clearIncomingChunkState(sessionId)
    this.app.appendLog(`接收完成，已保存来自 ${session.peerName} 的文件。`, "info")
    notifyIfHidden("接收完成", `来自 ${session.peerName} 的文件已保存`)
    await this.sendIncomingSessionAck(sessionId, ackTarget)
    this.app.clearTransferStatus()
    await this.app.refreshHistory()
  }

  async resumePendingSessions(targetPeerId = null) {
    if (!this.app.options.enableResume || !this.app.isConnected()) {
      return
    }
    const pendingSessions = await this.app.listSessionsByStatus("pending")
    for (const session of pendingSessions) {
      if (session.direction !== "incoming" || session.roomCode !== this.app.state.roomCode) {
        continue
      }
      if (targetPeerId && session.peerClientId !== targetPeerId) {
        continue
      }
      if (!this.app.state.peers.has(session.peerClientId)) {
        continue
      }
      this.app.sendSignal({
        type: "resume_request",
        target_client_id: session.peerClientId,
        session_id: session.sessionId,
      })
    }
  }
}
