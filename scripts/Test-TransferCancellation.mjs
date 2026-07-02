import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { URL as NodeURL } from "node:url"

globalThis.window = {
  location: { origin: "http://localhost" },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
}
globalThis.document = {
  createElement: () => ({
    href: "",
    download: "",
    click() {},
  }),
  body: {
    appendChild() {},
    removeChild() {},
  },
}
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { userAgent: "node-test" },
})
const localStorageItems = new Map()
globalThis.localStorage = {
  getItem: (key) => localStorageItems.get(key) || "",
  setItem(key, value) {
    localStorageItems.set(key, String(value))
  },
  clear() {
    localStorageItems.clear()
  },
}
globalThis.URL.createObjectURL = () => "blob:test"
globalThis.URL.revokeObjectURL = () => {}

const source = await readFile(new NodeURL("../static/core.js", import.meta.url), "utf8")
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
const { createTransferApp } = await import(moduleUrl)

const EXPECTED_STABLE_CHUNK_SIZE = 256 * 1024
const DEFAULT_ROOM_CODE = "DEFAULT"

function makeCancelledIncomingSession() {
  return {
    sessionId: "session-1",
    direction: "incoming",
    status: "cancelled",
    roomCode: "room",
    peerClientId: "peer-1",
    peerName: "Peer",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    fileCount: 1,
    totalSize: 1,
    filesMeta: [
      {
        file_id: "file-1",
        relative_path: "late.txt",
        size: 1,
        sha256: "not-used",
        chunk_size: 65536,
        chunk_count: 1,
      },
    ],
    completedChunks: {},
    errorMessage: "cancelled",
  }
}

function makePendingIncomingSession() {
  return {
    sessionId: "session-2",
    direction: "incoming",
    status: "pending",
    roomCode: "room",
    peerClientId: "peer-1",
    peerName: "Peer",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    fileCount: 1,
    totalSize: EXPECTED_STABLE_CHUNK_SIZE * 3,
    filesMeta: [
      {
        file_id: "file-1",
        relative_path: "big.bin",
        size: EXPECTED_STABLE_CHUNK_SIZE * 3,
        sha256: "not-used",
        chunk_size: EXPECTED_STABLE_CHUNK_SIZE,
        chunk_count: 3,
      },
    ],
    completedChunks: {},
  }
}

function makeHarness(session) {
  const app = createTransferApp()
  const sessions = new Map([[session.sessionId, { ...session }]])
  const chunks = []
  const updatePatches = []

  app.getSessionRecord = async (sessionId) => sessions.get(sessionId) || null
  app.updateSessionRecord = async (sessionId, patch) => {
    updatePatches.push({ sessionId, patch })
    sessions.set(sessionId, { ...(sessions.get(sessionId) || { sessionId }), ...patch })
  }
  app.upsertSessionRecord = async (record) => {
    sessions.set(record.sessionId, { ...record })
  }
  app.putChunk = async (record) => {
    chunks.push(record)
  }
  app.buildBlobFromChunks = async () => new Blob([new Uint8Array([1])])
  app.refreshHistory = async () => {}
  app.sendIncomingProgress = async () => false
  app.sendIncomingSessionAck = async () => false
  app.clearChunksBySession = async () => {
    chunks.length = 0
  }
  app.appendLog = () => {}
  app.notify = () => {}
  app.setTransferStatus = () => {}
  app.clearTransferStatus = () => {}

  return { app, sessions, chunks, updatePatches }
}

function makeTransferRequestHarness() {
  const app = createTransferApp()
  const sessionRecords = []
  const signals = []

  app.state.roomCode = "room"
  app.state.clientId = "sender-1"
  app.state.peers.set("peer-1", {
    client_id: "peer-1",
    display_name: "Peer",
  })
  app.state.selectedTransferPeerIds.add("peer-1")
  app.state.connections.set("peer-1", {
    peerId: "peer-1",
    channel: { readyState: "open" },
    channelState: "open",
  })
  app.state.selectedFiles = [
    {
      relativePath: "big.bin",
      file: new Blob([new Uint8Array(EXPECTED_STABLE_CHUNK_SIZE + 7)]),
    },
  ]

  app.upsertSessionRecord = async (record) => {
    sessionRecords.push(record)
  }
  app.refreshHistory = async () => {}
  app.sendSignal = (payload) => {
    signals.push(payload)
  }
  app.appendLog = () => {}
  app.notify = () => {}
  app.setTransferStatus = () => {}
  app.clearTransferStatus = () => {}

  return { app, sessionRecords, signals }
}

test("initial form state defaults to the shared room and a stable device name", () => {
  localStorage.clear()
  const app = createTransferApp()
  const initial = app.getInitialFormState()

  assert.equal(initial.roomCode, DEFAULT_ROOM_CODE)
  assert.match(initial.displayName, /^设备-[0-9A-F]{6}$/)
  assert.equal(localStorage.getItem("web-transfer-room-code"), DEFAULT_ROOM_CODE)
  assert.equal(localStorage.getItem("web-transfer-display-name"), initial.displayName)
})

test("initialize automatically joins the default room", async () => {
  localStorage.clear()
  const app = createTransferApp()
  const calls = []

  app.connectToRoom = async (roomCode, displayName) => {
    calls.push({ roomCode, displayName })
    return true
  }
  app.appendLog = () => {}
  app.notify = () => {}

  await app.initialize()

  assert.equal(calls.length, 1)
  assert.equal(calls[0].roomCode, DEFAULT_ROOM_CODE)
  assert.match(calls[0].displayName, /^设备-[0-9A-F]{6}$/)
})

test("new transfer requests advertise stable 256 KB chunks", async () => {
  const { app, sessionRecords, signals } = makeTransferRequestHarness()

  const started = await app.startTransferRequest()

  assert.equal(started, true)
  assert.equal(sessionRecords.length, 1)
  assert.equal(sessionRecords[0].filesMeta[0].chunk_size, EXPECTED_STABLE_CHUNK_SIZE)
  assert.equal(sessionRecords[0].filesMeta[0].chunk_count, 2)
  assert.equal(signals.length, 1)
  assert.equal(signals[0].files[0].chunk_size, EXPECTED_STABLE_CHUNK_SIZE)
  assert.equal(signals[0].files[0].chunk_count, 2)
})

test("late chunk does not revive a cancelled incoming session", async () => {
  const { app, sessions, chunks } = makeHarness(makeCancelledIncomingSession())

  await app.storeIncomingChunk(
    {
      session_id: "session-1",
      file_id: "file-1",
      chunk_index: 0,
    },
    new Uint8Array([1]).buffer
  )

  assert.equal(sessions.get("session-1").status, "cancelled")
  assert.equal(chunks.length, 0)
})

test("late session completion does not complete a cancelled incoming session", async () => {
  const { app, sessions } = makeHarness(makeCancelledIncomingSession())

  await app.finalizeIncomingSession("session-1")

  assert.equal(sessions.get("session-1").status, "cancelled")
  assert.equal(sessions.get("session-1").completedAt, null)
})

test("incoming chunks persist immediately while session progress flushes in batches", async () => {
  const { app, sessions, chunks, updatePatches } = makeHarness(makePendingIncomingSession())

  await app.storeIncomingChunk(
    {
      session_id: "session-2",
      file_id: "file-1",
      chunk_index: 0,
    },
    new Uint8Array([1]).buffer
  )
  await app.storeIncomingChunk(
    {
      session_id: "session-2",
      file_id: "file-1",
      chunk_index: 1,
    },
    new Uint8Array([2]).buffer
  )

  assert.equal(chunks.length, 2)
  assert.equal(updatePatches.length, 0)
  assert.deepEqual(sessions.get("session-2").completedChunks, {})

  await app.flushIncomingChunkState("session-2", { status: "pending" })

  assert.equal(updatePatches.length, 1)
  assert.deepEqual(sessions.get("session-2").completedChunks, { "file-1": [0, 1] })
})
