import { icons } from "./icons.js"
import { collectDroppedFiles, collectInputFiles } from "../entry-helpers.js"
import { copyTextToClipboard } from "../utils/clipboard.js"
import { drawQrToCanvas } from "../utils/qr.js"
import { notifyIfHidden, requestNotificationPermission } from "../utils/notify.js"
import {
  CHAT_FILE_MAX_BYTES,
  CHAT_TEXT_COLLAPSE_CHARS,
  CHAT_TEXT_COLLAPSE_LINES,
} from "../constants.js"
import {
  formatBytes,
  formatChatTime,
  formatFileSummary,
  formatTransferSpeed,
  historyBadgeClass,
} from "../utils/format.js"

// DOM 构造助手：h("div", { class: "row", dataset: { id: "1" } }, children...)
function h(tag, props, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) {
      continue
    }
    if (key === "class") {
      node.className = value
    } else if (key === "dataset") {
      for (const [dataKey, dataValue] of Object.entries(value)) {
        node.dataset[dataKey] = dataValue
      }
    } else if (key === "html") {
      node.innerHTML = value
    } else if (key in node && key !== "title") {
      try {
        node[key] = value
      } catch {
        node.setAttribute(key, String(value))
      }
    } else {
      node.setAttribute(key, String(value))
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) {
      continue
    }
    node.append(child.nodeType ? child : document.createTextNode(String(child)))
  }
  return node
}

function icon(name, className = "") {
  const span = h("span", { class: `icon ${className}`.trim() })
  span.innerHTML = icons[name]
  return span
}

function emptyState(message, iconName = "inbox") {
  return h(
    "div",
    { class: "empty" },
    icon(iconName, "empty-icon"),
    h("p", { class: "empty-text" }, message)
  )
}

// 列表渲染通用模式：先算 markup 再整体替换，避免逐项重建时的布局抖动。
function replaceChildren(container, ...nodes) {
  container.replaceChildren(...nodes.flat().filter(Boolean))
}

function peerChannelLabel(connection) {
  if (connection && connection.channelState === "open") {
    return { text: "直连", tone: "ok" }
  }
  return { text: "中继", tone: "muted" }
}

function shortId(clientId) {
  return String(clientId || "").slice(0, 8)
}

export function createView(app) {
  const els = {
    connectionBadge: document.querySelector("#connectionBadge"),
    localClientId: document.querySelector("#localClientId"),
    peerCount: document.querySelector("#peerCount"),
    inviteBtn: document.querySelector("#inviteBtn"),
    displayName: document.querySelector("#displayName"),
    roomCode: document.querySelector("#roomCode"),
    connectBtn: document.querySelector("#connectBtn"),
    disconnectBtn: document.querySelector("#disconnectBtn"),
    peerList: document.querySelector("#peerList"),
    pendingTransfers: document.querySelector("#pendingTransfers"),
    resumeTransfers: document.querySelector("#resumeTransfers"),
    resumeFileInput: document.querySelector("#resumeFileInput"),
    resumeDirInput: document.querySelector("#resumeDirInput"),
    selectedPeerName: document.querySelector("#selectedPeerName"),
    sendHint: document.querySelector("#sendHint"),
    sendCard: document.querySelector("#sendCard"),
    fileInput: document.querySelector("#fileInput"),
    directoryInput: document.querySelector("#directoryInput"),
    directoryLabel: document.querySelector("#directoryLabel"),
    dropZone: document.querySelector("#dropZone"),
    selectionList: document.querySelector("#selectionList"),
    sendBtn: document.querySelector("#sendBtn"),
    chatPeerName: document.querySelector("#chatPeerName"),
    chatHint: document.querySelector("#chatHint"),
    chatList: document.querySelector("#chatList"),
    chatInput: document.querySelector("#chatInput"),
    chatSendBtn: document.querySelector("#chatSendBtn"),
    chatAttachBtn: document.querySelector("#chatAttachBtn"),
    chatFileInput: document.querySelector("#chatFileInput"),
    chatPending: document.querySelector("#chatPending"),
    historyList: document.querySelector("#historyList"),
    clearHistoryBtn: document.querySelector("#clearHistoryBtn"),
    transferActionBtn: document.querySelector("#transferActionBtn"),
    transferBadge: document.querySelector("#transferBadge"),
    transferProgress: document.querySelector("#transferProgress"),
    transferLog: document.querySelector("#transferLog"),
    historyCard: document.querySelector("#historyCard"),
    chatCard: document.querySelector("#chatCard"),
    inviteModal: document.querySelector("#inviteModal"),
    inviteClose: document.querySelector("#inviteClose"),
    inviteQr: document.querySelector("#inviteQr"),
    inviteUrl: document.querySelector("#inviteUrl"),
    inviteIp: document.querySelector("#inviteIp"),
    inviteCopy: document.querySelector("#inviteCopy"),
  }

  let lastChatPeerId = null
  let lastChatCount = 0
  let pendingChatAttachments = []
  let pendingResumeSessionId = null

  function render() {
    renderConnection()
    renderPeers()
    renderPendingTransfers()
    renderResumeCards()
    renderSendSection()
    renderSelection()
    renderChat()
    renderHistory()
    renderTransfer()
  }

  function formatPeerSummary(peers) {
    if (!peers.length) {
      return "未选择"
    }
    if (peers.length === 1) {
      return peers[0].display_name
    }
    if (peers.length === 2) {
      return `${peers[0].display_name}、${peers[1].display_name}`
    }
    return `${peers[0].display_name} 等 ${peers.length} 台设备`
  }

  function renderSendSection() {
    const connected = app.isConnected()
    const selectedPeers = app.getSelectedTransferPeers()
    const hasDirect = selectedPeers.some((peer) => {
      const connection = app.getConnection(peer.client_id)
      return Boolean(connection && connection.channelState === "open")
    })
    const canSend = Boolean(connected && selectedPeers.length)

    const summary = formatPeerSummary(selectedPeers)
    els.selectedPeerName.textContent = summary
    els.selectedPeerName.title = summary

    els.sendHint.className = `badge ${canSend ? "ok" : "muted"}`
    els.sendHint.textContent = !canSend ? "等待设备" : hasDirect ? "可直连传输" : "可中继传输"
    els.sendBtn.disabled = !(canSend && app.state.selectedFiles.length)
  }

  function renderConnection() {
    const connected = app.isConnected()
    const state = app.state

    els.connectionBadge.className = `badge ${connected ? "ok" : "muted"}`
    replaceChildren(
      els.connectionBadge,
      h("span", { class: `dot ${connected ? "ok" : "muted"}` }),
      connected ? `已连接 · ${state.roomCode}` : "未连接"
    )
    els.connectionBadge.title = connected ? `房间 ${state.roomCode}` : ""

    replaceChildren(els.localClientId, h("code", { class: "chip" }, shortId(state.clientId) || "————"))
    els.localClientId.title = state.clientId || ""

    els.peerCount.textContent = `${state.peers.size} 台`
    els.inviteBtn.hidden = !connected
    els.displayName.value = state.formDisplayName
    els.roomCode.value = state.formRoomCode
    els.connectBtn.disabled = connected
    els.disconnectBtn.disabled = !connected
  }

  function renderPeers() {
    const peers = Array.from(app.state.peers.values())
    els.peerCount.textContent = `${peers.length} 台`

    if (!peers.length) {
      els.peerList.className = "list empty-box"
      replaceChildren(els.peerList, emptyState("房间里还没有其他设备，把地址发给对方吧。", "device"))
      return
    }

    els.peerList.className = "list peer-list"
    const nodes = peers.map((peer) => {
      const connection = app.getConnection(peer.client_id)
      const unread = app.getUnreadCount(peer.client_id)
      const isChatSelected = peer.client_id === app.state.selectedPeerId
      const isSendSelected = app.isTransferPeerSelected(peer.client_id)
      const channel = peerChannelLabel(connection)

      const card = h(
        "div",
        {
          class:
            "peer-card" +
            (isChatSelected ? " chat-selected" : "") +
            (isSendSelected ? " send-selected" : ""),
          dataset: { peerId: peer.client_id },
        },
        h("span", { class: "avatar", "aria-hidden": "true" }, (peer.display_name || "?").slice(0, 1).toUpperCase()),
        h(
          "div",
          { class: "peer-copy" },
          h("strong", { class: "peer-name ellipsis", title: peer.display_name }, peer.display_name),
          h(
            "span",
            { class: "peer-meta" },
            h("code", { class: "chip chip-mini" }, shortId(peer.client_id)),
            h("span", { class: `state state-${channel.tone}` }, h("span", { class: `dot ${channel.tone}` }), channel.text)
          )
        ),
        unread
          ? h("span", { class: "unread-dot", title: `${unread} 条新消息` }, unread > 99 ? "99+" : String(unread))
          : null,
        h(
          "button",
          {
            type: "button",
            class: `btn btn-mini ghost peer-toggle${isSendSelected ? " active" : ""}`,
            dataset: { action: "toggle-send", peerId: peer.client_id },
          },
          isSendSelected ? "已选发送" : "加入发送"
        )
      )
      return card
    })
    replaceChildren(els.peerList, nodes)
  }

  function renderPendingTransfers() {
    const requests = Array.from(app.state.pendingIncomingRequests.values())
    if (!requests.length) {
      els.pendingTransfers.hidden = true
      replaceChildren(els.pendingTransfers)
      return
    }

    els.pendingTransfers.hidden = false
    const nodes = requests.map((request) =>
      h(
        "div",
        { class: "pending-card" },
        h(
          "div",
          { class: "pending-copy" },
          h("strong", { class: "pending-title" }, `${request.peerName} → 你`),
          h(
            "p",
            { class: "pending-meta", title: formatFileSummary(request.files, 6) },
            `${formatFileSummary(request.files)} · ${formatBytes(request.totalSize)}${request.isResume ? " · 可续传" : ""}`
          )
        ),
        h(
          "div",
          { class: "pending-actions" },
          h(
            "button",
            {
              type: "button",
              class: "btn btn-mini primary",
              dataset: { action: "accept-transfer", sessionId: request.sessionId },
            },
            "接收"
          ),
          h(
            "button",
            {
              type: "button",
              class: "btn btn-mini ghost",
              dataset: { action: "reject-transfer", sessionId: request.sessionId },
            },
            "拒绝"
          )
        )
      )
    )
    replaceChildren(els.pendingTransfers, nodes)
  }

  function renderSelection() {
    const files = app.state.selectedFiles

    if (!files.length) {
      els.selectionList.className = "list empty-box"
      replaceChildren(els.selectionList, emptyState("还没有选择要发送的内容。", "file"))
      return
    }

    els.selectionList.className = "list selection-list"
    const nodes = files.map((item, index) =>
      h(
        "div",
        { class: "selection-item" },
        icon("file", "item-icon"),
        h(
          "div",
          { class: "selection-copy" },
          h("strong", { class: "ellipsis", title: item.relativePath }, item.relativePath),
          h("span", { class: "selection-meta" }, formatBytes(item.file.size))
        ),
        h("button", {
          type: "button",
          class: "icon-btn",
          title: "移除",
          "aria-label": `移除 ${item.relativePath}`,
          dataset: { action: "remove-file", index: String(index) },
          html: icons.close,
        })
      )
    )
    replaceChildren(els.selectionList, nodes)
  }

  function renderChat() {
    const peerId = app.state.selectedPeerId
    const peerName = peerId ? app.getPeerName(peerId) : null
    els.chatPeerName.textContent = peerName || "未选择"
    els.chatPeerName.title = peerName || ""

    const connected = app.isConnected()
    const hasPeer = Boolean(peerId)
    els.chatHint.className = `badge ${hasPeer && connected ? "ok" : "muted"}`
    els.chatHint.textContent = !hasPeer ? "未选择设备" : connected ? "可发送" : "未连接"

    els.chatSendBtn.disabled = !(hasPeer && (els.chatInput.value.trim() || pendingChatAttachments.length))
    renderPendingChatAttachments()

    const messages = peerId ? app.getChatMessages(peerId) : []
    if (!peerId) {
      els.chatList.className = "list empty-box"
      replaceChildren(els.chatList, emptyState("在房间设备里选择一台设备，开始互发消息、图片和文件。", "chat"))
      return
    }

    if (!messages.length) {
      els.chatList.className = "list empty-box"
      replaceChildren(els.chatList, emptyState(`和 ${peerName} 还没有消息，发一条试试。`, "chat"))
      return
    }

    els.chatList.className = "list chat-list"
    const grewByPeer = peerId === lastChatPeerId && messages.length > lastChatCount
    const nearBottom =
      els.chatList.scrollHeight - els.chatList.scrollTop - els.chatList.clientHeight < 48
    replaceChildren(
      els.chatList,
      messages.map((message, index) => {
        const nodes = []
        if (message.attachment) {
          nodes.push(renderAttachment(message))
        }
        if (message.text) {
          const collapsible = isCollapsibleText(message.text)
          nodes.push(h("p", { class: `chat-text${collapsible && !message.expanded ? " collapsed" : ""}` }, message.text))
          if (collapsible) {
            nodes.push(
              h("button", {
                type: "button",
                class: "chat-expand-btn",
                dataset: { action: "toggle-expand", index: String(index) },
              }, message.expanded ? "收起" : "展开全部")
            )
          }
        }
        return h(
          "div",
          { class: `chat-item ${message.direction}` },
          h(
            "div",
            { class: "chat-item-header" },
            h("strong", { class: "ellipsis", title: message.peerName }, message.direction === "incoming" ? message.peerName : "你"),
            message.text
              ? h("button", {
                  type: "button",
                  class: "icon-btn chat-copy",
                  title: "复制消息",
                  "aria-label": "复制这条消息",
                  dataset: { action: "copy-message", index: String(index) },
                  html: icons.copy,
                })
              : null,
            h("time", { class: "chat-time", title: formatChatTime(message.timestamp) }, formatChatTime(message.timestamp))
          ),
          nodes
        )
      })
    )
    if (grewByPeer && nearBottom) {
      els.chatList.scrollTop = els.chatList.scrollHeight
    }
    lastChatPeerId = peerId
    lastChatCount = messages.length
  }

  function renderAttachment(message) {
    const { attachment } = message
    if (attachment.isImage) {
      return h("img", {
        class: "chat-image",
        src: attachment.url,
        alt: attachment.name,
        title: `${attachment.name}（点击放大）`,
        dataset: { action: "open-image" },
        loading: "lazy",
      })
    }
    return h(
      "a",
      {
        class: "chat-file-chip",
        href: attachment.url,
        download: attachment.name,
        title: `下载 ${attachment.name}`,
      },
      icon("file", "item-icon"),
      h(
        "span",
        { class: "chat-file-copy" },
        h("span", { class: "ellipsis", title: attachment.name }, attachment.name),
        h("span", { class: "chat-file-meta" }, formatBytes(attachment.size))
      )
    )
  }

  function renderPendingChatAttachments() {
    if (!pendingChatAttachments.length) {
      els.chatPending.hidden = true
      replaceChildren(els.chatPending)
      return
    }

    els.chatPending.hidden = false
    replaceChildren(
      els.chatPending,
      pendingChatAttachments.map((item, index) =>
        h(
          "span",
          { class: "chat-pending-chip" },
          item.previewUrl
            ? h("img", { class: "chat-pending-thumb", src: item.previewUrl, alt: "" })
            : icon("file", "item-icon"),
          h("span", { class: "ellipsis chat-pending-name", title: item.file.name }, item.file.name),
          h("span", { class: "chat-pending-size" }, formatBytes(item.file.size)),
          h("button", {
            type: "button",
            class: "icon-btn",
            title: "移除",
            "aria-label": `移除 ${item.file.name}`,
            dataset: { action: "remove-pending", index: String(index) },
            html: icons.close,
          })
        )
      )
    )
  }

  function renderResumeCards() {
    const entries = Array.from(app.state.pendingOutgoingResumes.values())
    if (!entries.length) {
      els.resumeTransfers.hidden = true
      replaceChildren(els.resumeTransfers)
      return
    }

    els.resumeTransfers.hidden = false
    replaceChildren(
      els.resumeTransfers,
      entries.map(({ record, done, total }) =>
        h(
          "div",
          { class: "pending-card" },
          h(
            "div",
            { class: "pending-copy" },
            h("strong", { class: "pending-title" }, `上次发给 ${record.peerName || "未知设备"} 的传输未完成`),
            h(
              "p",
              { class: "pending-meta", title: formatFileSummary(record.filesMeta, 6) },
              `${formatFileSummary(record.filesMeta)} · ${formatBytes(done)}/${formatBytes(total)}（${total ? Math.round((done / total) * 100) : 0}%）`
            )
          ),
          h(
            "div",
            { class: "pending-actions" },
            h(
              "button",
              {
                type: "button",
                class: "btn btn-mini primary",
                dataset: { action: "select-resume-files", sessionId: record.sessionId },
              },
              "选择文件继续"
            ),
            h(
              "button",
              {
                type: "button",
                class: "btn btn-mini ghost",
                dataset: { action: "ignore-resume", sessionId: record.sessionId },
              },
              "稍后"
            )
          )
        )
      )
    )
  }

  function isCollapsibleText(text) {
    const lines = String(text || "").split("\n").length
    return String(text || "").length > CHAT_TEXT_COLLAPSE_CHARS || lines > CHAT_TEXT_COLLAPSE_LINES
  }

  function addPendingChatAttachments(fileList) {
    const files = Array.from(fileList || [])
    if (!files.length) {
      return
    }
    for (const file of files) {
      if (file.size > CHAT_FILE_MAX_BYTES) {
        app.appendLog(
          `${file.name} 超过聊天附件上限（${Math.round(CHAT_FILE_MAX_BYTES / 1024 / 1024)}MB），请改用“发送文件”。`,
          "warn"
        )
        continue
      }
      const isImage = (file.type || "").startsWith("image/")
      pendingChatAttachments.push({
        file,
        previewUrl: isImage && pendingChatAttachments.length < 10 ? URL.createObjectURL(file) : null,
      })
    }
    if (pendingChatAttachments.length > 10) {
      const overflow = pendingChatAttachments.splice(10)
      app.appendLog(`单次最多附带 10 个附件，已移除 ${overflow.length} 个。`, "warn")
    }
    render()
  }

  function renderHistory() {
    const sessions = app.state.history
    if (!sessions.length) {
      els.historyList.className = "list empty-box"
      replaceChildren(els.historyList, emptyState("还没有历史记录。", "history"))
      return
    }

    els.historyList.className = "list history-list"
    replaceChildren(
      els.historyList,
      sessions.map((session) => {
        const incoming = session.direction === "incoming"
        const targetLabel = incoming ? `来自 ${session.peerName || "未知设备"}` : `发给 ${session.peerName || "未知设备"}`
        const timeLabel = session.completedAt
          ? new Date(session.completedAt).toLocaleString()
          : "未完成"
        const badgeClass = historyBadgeClass(session.status)
        return h(
          "div",
          { class: `history-item ${session.direction}` },
          h("span", { class: "item-icon" }, incoming ? "↓" : "↑"),
          h(
            "div",
            { class: "history-copy" },
            h(
              "div",
              { class: "history-title-row" },
              h("strong", { class: "ellipsis", title: targetLabel }, targetLabel),
              h("span", { class: `badge ${badgeClass || "ok"}` }, session.status)
            ),
            h("p", { class: "history-files ellipsis", title: formatFileSummary(session.filesMeta, 6) }, formatFileSummary(session.filesMeta, 4)),
            h("p", { class: "history-meta" }, `${formatBytes(session.totalSize)} · ${timeLabel}`)
          )
        )
      })
    )
  }

  function renderTransfer() {
    const action = app.getTransferAction()
    els.transferActionBtn.hidden = !action
    els.transferActionBtn.textContent = action ? action.label : "停止传输"
    if (action) {
      replaceChildren(els.transferActionBtn, icon("stop"), action.label)
    }

    const status = app.state.transferStatus
    if (status && status.total) {
      document.title = `${status.percent}% · 文件传输`
    } else if (status) {
      document.title = `传输中 · 文件传输`
    } else if (document.title !== "文件传输") {
      document.title = "文件传输"
    }
    if (status) {
      els.transferBadge.className = "badge ok"
      els.transferBadge.textContent = formatTransferSpeed(status.speed)
      els.transferProgress.hidden = false
      replaceChildren(
        els.transferProgress,
        h(
          "div",
          { class: "progress-head" },
          h("strong", { class: "ellipsis", title: status.label }, status.label),
          h("span", { class: "progress-percent" }, `${status.percent}%`)
        ),
        h(
          "div",
          { class: "progress-bar", role: "progressbar", "aria-valuenow": status.percent, "aria-valuemin": 0, "aria-valuemax": 100 },
          h("span", { style: `width: ${status.percent}%` })
        ),
        h(
          "div",
          { class: "progress-meta" },
          h("span", null, `${formatBytes(status.done)} / ${formatBytes(status.total)}`),
          h("span", null, formatTransferSpeed(status.speed))
        )
      )
    } else {
      els.transferBadge.className = "badge muted"
      els.transferBadge.textContent = "空闲"
      els.transferProgress.hidden = true
      replaceChildren(els.transferProgress)
    }

    els.transferLog.className = "list log-list"
    const logNodes = app.state.logs.map((entry) =>
      h(
        "div",
        { class: `log-item level-${entry.level}` },
        h("span", { class: "log-dot", "aria-hidden": "true" }),
        h("time", { class: "log-time" }, new Date(entry.timestamp).toLocaleTimeString([], { hour12: false })),
        h("p", { class: "log-text", title: entry.message }, entry.message)
      )
    )
    if (!logNodes.length) {
      replaceChildren(els.transferLog, emptyState("传输事件会显示在这里。", "activity"))
    } else {
      replaceChildren(els.transferLog, logNodes)
    }
  }

  function bind() {
    const isMobile = app.runtime.isMobileBrowser

    // 传输进行中离开/换房需确认，避免误杀传输
    const confirmIfActiveTransfers = () => {
      if (!app.hasActiveTransfers()) {
        return true
      }
      return window.confirm("有传输正在进行，离开会中断传输。确定继续吗？")
    }

    els.connectBtn.addEventListener("click", () => {
      if (!confirmIfActiveTransfers()) {
        return
      }
      requestNotificationPermission()
      app.state.formDisplayName = els.displayName.value.trim() || app.state.formDisplayName
      app.connectToRoom(els.roomCode.value, els.displayName.value)
    })
    els.disconnectBtn.addEventListener("click", () => {
      if (confirmIfActiveTransfers()) {
        app.disconnectFromRoom()
      }
    })
    window.addEventListener("beforeunload", (event) => {
      if (app.hasActiveTransfers()) {
        event.preventDefault()
        event.returnValue = ""
      }
    })

    els.fileInput.multiple = app.options.allowMultipleFiles
    els.fileInput.addEventListener("change", (event) => {
      app.setSelectedFiles(collectInputFiles(event.target.files, { allowMultipleFiles: app.options.allowMultipleFiles }))
      event.target.value = ""
    })
    if (els.directoryInput) {
      if (isMobile) {
        els.directoryLabel.hidden = true
      }
      els.directoryInput.addEventListener("change", (event) => {
        app.setSelectedFiles(collectInputFiles(event.target.files, { allowMultipleFiles: app.options.allowMultipleFiles }))
        event.target.value = ""
      })
    }

    if (els.dropZone && !isMobile) {
      els.dropZone.addEventListener("dragover", (event) => {
        event.preventDefault()
        els.dropZone.classList.add("active")
      })
      els.dropZone.addEventListener("dragleave", () => els.dropZone.classList.remove("active"))
      els.dropZone.addEventListener("drop", async (event) => {
        event.preventDefault()
        els.dropZone.classList.remove("active")
        app.setSelectedFiles(await collectDroppedFiles(event.dataTransfer, { allowMultipleFiles: app.options.allowMultipleFiles }))
      })
      els.dropZone.addEventListener("click", () => els.fileInput.click())
    } else if (els.dropZone) {
      els.dropZone.hidden = true
    }

    els.sendBtn.addEventListener("click", () => app.startTransferRequest())
    els.clearHistoryBtn.addEventListener("click", () => app.clearHistory())
    els.transferActionBtn.addEventListener("click", () => app.performTransferAction())

    els.chatInput.addEventListener("input", render)
    els.chatInput.addEventListener("keydown", async (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        await sendChat()
      }
    })
    els.chatInput.addEventListener("paste", (event) => {
      const pastedFiles = event.clipboardData && event.clipboardData.files
      if (pastedFiles && pastedFiles.length) {
        event.preventDefault()
        addPendingChatAttachments(pastedFiles)
      }
    })

    // 邀请弹窗（扫码进房）
    let inviteCandidates = []
    let inviteSelectedIp = ""
    const inviteUrlFor = (ip) => {
      const url = new URL("/", window.location.origin)
      url.hostname = ip
      url.searchParams.set("room", app.state.roomCode)
      return url.toString()
    }
    const renderInvite = () => {
      els.inviteIp.replaceChildren(
        ...inviteCandidates.map((candidate) => {
          const isCurrent = candidate.ip === window.location.hostname
          const label = candidate.interface ? `${candidate.ip}（${candidate.interface}）` : candidate.ip
          return h("option", { value: candidate.ip }, isCurrent ? `${candidate.ip}（当前地址）` : label)
        })
      )
      els.inviteIp.value = inviteSelectedIp
      const url = inviteUrlFor(inviteSelectedIp)
      els.inviteUrl.textContent = url
      els.inviteUrl.title = url
      drawQrToCanvas(els.inviteQr, url)
    }
    const openInvite = async () => {
      if (!app.isConnected()) {
        return
      }
      els.inviteModal.hidden = false
      let serverCandidates = []
      try {
        const response = await fetch("/api/lan")
        if (response.ok) {
          serverCandidates = (await response.json()).candidates || []
        }
      } catch {
        // 接口失败时退回当前页面地址
      }
      // 兼容字符串与 {ip, interface} 两种形状
      inviteCandidates = [
        { ip: window.location.hostname, interface: "" },
        ...serverCandidates.map((candidate) =>
          typeof candidate === "string" ? { ip: candidate, interface: "" } : { ip: candidate.ip, interface: candidate.interface || "" }
        ),
      ].filter((candidate, index, list) => candidate.ip && list.findIndex((other) => other.ip === candidate.ip) === index)
      const usable = (ip) => ip && !ip.startsWith("127.") && !ip.startsWith("169.254.")
      if (usable(window.location.hostname)) {
        inviteSelectedIp = window.location.hostname
      } else {
        inviteSelectedIp = (inviteCandidates.find((candidate) => usable(candidate.ip)) || inviteCandidates[0] || { ip: window.location.hostname }).ip
      }
      renderInvite()
    }
    els.inviteBtn.addEventListener("click", () => void openInvite())
    els.inviteClose.addEventListener("click", () => {
      els.inviteModal.hidden = true
    })
    els.inviteModal.addEventListener("click", (event) => {
      if (event.target === els.inviteModal) {
        els.inviteModal.hidden = true
      }
    })
    els.inviteIp.addEventListener("change", () => {
      inviteSelectedIp = els.inviteIp.value
      renderInvite()
    })
    els.inviteCopy.addEventListener("click", async () => {
      const copied = await copyTextToClipboard(inviteUrlFor(inviteSelectedIp))
      if (copied) {
        els.inviteCopy.textContent = "已复制"
        window.setTimeout(() => {
          els.inviteCopy.textContent = "复制链接"
        }, 1200)
      }
    })

    // 发送端断点续传：恢复卡片与文件选择
    els.resumeTransfers.addEventListener("click", (event) => {
      const select = event.target.closest("[data-action='select-resume-files']")
      if (select) {
        pendingResumeSessionId = select.dataset.sessionId
        els.resumeFileInput.click()
        return
      }
      const ignore = event.target.closest("[data-action='ignore-resume']")
      if (ignore) {
        app.state.pendingOutgoingResumes.delete(ignore.dataset.sessionId)
        render()
      }
    })
    const handleResumeSelection = (event) => {
      const sessionId = pendingResumeSessionId
      pendingResumeSessionId = null
      const files = Array.from(event.target.files || [])
      event.target.value = ""
      if (!sessionId || !files.length) {
        return
      }
      void app.completeOutgoingResume(sessionId, collectInputFiles(files))
    }
    els.resumeFileInput.addEventListener("change", handleResumeSelection)
    els.resumeDirInput.addEventListener("change", handleResumeSelection)

    // 整页拖拽：拖到聊天卡片作为聊天附件，其他位置作为传输文件
    const dragHasFiles = (event) =>
      Boolean(event.dataTransfer && Array.from(event.dataTransfer.types || []).includes("Files"))
    const clearDragHighlights = () => {
      els.chatCard.classList.remove("drag-over")
      els.sendCard.classList.remove("drag-over")
    }
    document.addEventListener("dragenter", (event) => {
      if (dragHasFiles(event)) {
        event.preventDefault()
      }
    })
    document.addEventListener("dragover", (event) => {
      if (!dragHasFiles(event)) {
        return
      }
      event.preventDefault()
      const overChat = Boolean(event.target.closest?.("#chatCard"))
      const inSend = Boolean(event.target.closest?.("#sendCard"))
      els.chatCard.classList.toggle("drag-over", overChat)
      els.sendCard.classList.toggle("drag-over", !overChat && !inSend)
    })
    document.addEventListener("dragleave", (event) => {
      if (event.target === document || event.target === document.documentElement) {
        clearDragHighlights()
      }
    })
    document.addEventListener("drop", async (event) => {
      clearDragHighlights()
      if (!dragHasFiles(event) || event.defaultPrevented) {
        return
      }
      // 阻止浏览器直接打开文件；dropZone 自己的处理器已处理过的情况不再重复
      event.preventDefault()
      const droppedOnChat = Boolean(event.target.closest?.("#chatCard"))
      const files = await collectDroppedFiles(event.dataTransfer, {
        allowMultipleFiles: app.options.allowMultipleFiles,
      })
      if (!files.length) {
        return
      }
      if (droppedOnChat) {
        addPendingChatAttachments(files.map((item) => item.file))
      } else {
        app.setSelectedFiles(files)
      }
    })
    els.chatAttachBtn.addEventListener("click", () => els.chatFileInput.click())
    els.chatFileInput.addEventListener("change", (event) => {
      addPendingChatAttachments(event.target.files)
      event.target.value = ""
    })
    els.chatSendBtn.addEventListener("click", () => sendChat())

    // 设备卡、待确认传输、文件移除都走事件委托，重渲染不丢监听。
    els.peerList.addEventListener("click", (event) => {
      const toggle = event.target.closest("[data-action='toggle-send']")
      if (toggle) {
        app.toggleTransferPeer(toggle.dataset.peerId)
        return
      }
      const card = event.target.closest(".peer-card")
      if (card) {
        app.selectPeer(card.dataset.peerId)
      }
    })
    els.pendingTransfers.addEventListener("click", (event) => {
      const accept = event.target.closest("[data-action='accept-transfer']")
      if (accept) {
        app.acceptIncomingTransfer(accept.dataset.sessionId)
        return
      }
      const reject = event.target.closest("[data-action='reject-transfer']")
      if (reject) {
        app.rejectIncomingTransfer(reject.dataset.sessionId)
      }
    })
    els.selectionList.addEventListener("click", (event) => {
      const remove = event.target.closest("[data-action='remove-file']")
      if (remove) {
        app.removeSelectedFile(Number(remove.dataset.index))
      }
    })

    // 聊天区交互：展开/收起、图片放大、待发附件移除、消息复制，全部事件委托。
    els.chatList.addEventListener("click", async (event) => {
      const expand = event.target.closest("[data-action='toggle-expand']")
      if (expand) {
        const peerId = app.state.selectedPeerId
        const messages = peerId ? app.getChatMessages(peerId) : []
        const message = messages[Number(expand.dataset.index)]
        if (message) {
          message.expanded = !message.expanded
          render()
        }
        return
      }
      const image = event.target.closest("[data-action='open-image']")
      if (image) {
        window.open(image.src, "_blank")
        return
      }
      const button = event.target.closest("[data-action='copy-message']")
      if (!button) {
        return
      }
      const peerId = app.state.selectedPeerId
      const messages = peerId ? app.getChatMessages(peerId) : []
      const message = messages[Number(button.dataset.index)]
      if (!message || !message.text) {
        return
      }
      const copied = await copyTextToClipboard(message.text)
      if (copied) {
        button.classList.add("copied")
        button.innerHTML = icons.check
        window.setTimeout(() => {
          button.classList.remove("copied")
          button.innerHTML = icons.copy
        }, 1200)
      } else {
        app.appendLog("复制失败，请手动选择文本复制。", "warn")
      }
    })

    els.chatPending.addEventListener("click", (event) => {
      const remove = event.target.closest("[data-action='remove-pending']")
      if (!remove) {
        return
      }
      const index = Number(remove.dataset.index)
      const item = pendingChatAttachments[index]
      if (item && item.previewUrl) {
        URL.revokeObjectURL(item.previewUrl)
      }
      pendingChatAttachments.splice(index, 1)
      render()
    })

    els.localClientId.addEventListener("click", async () => {
      const clientId = app.state.clientId
      if (!clientId) {
        return
      }
      const copied = await copyTextToClipboard(clientId)
      if (copied) {
        els.localClientId.classList.add("copied")
        window.setTimeout(() => els.localClientId.classList.remove("copied"), 900)
      } else {
        app.appendLog("复制客户端 ID 失败，请手动选择复制。", "warn")
      }
    })

    window.addEventListener("error", (event) => {
      app.appendLog(`页面错误: ${event.message}`, "danger")
    })
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason instanceof Error ? event.reason.message : String(event.reason)
      app.appendLog(`未处理异常: ${reason}`, "danger")
    })
  }

  async function sendChat() {
    const text = els.chatInput.value.trim()
    let textSent = false
    if (text) {
      textSent = await app.sendChatMessage(text)
      if (textSent) {
        els.chatInput.value = ""
      }
    }

    const remaining = []
    for (const item of pendingChatAttachments) {
      const sent = await app.sendChatAttachment(item.file)
      if (!sent) {
        remaining.push(item)
      }
    }
    pendingChatAttachments = remaining
    render()
  }

  return { els, render, bind }
}
