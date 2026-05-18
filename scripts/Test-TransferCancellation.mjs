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
globalThis.localStorage = {
  getItem: () => "",
  setItem() {},
}
globalThis.URL.createObjectURL = () => "blob:test"
globalThis.URL.revokeObjectURL = () => {}

const source = await readFile(new NodeURL("../static/core.js", import.meta.url), "utf8")
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
const { createTransferApp } = await import(moduleUrl)

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

function makeHarness(session) {
  const app = createTransferApp()
  const sessions = new Map([[session.sessionId, { ...session }]])
  const chunks = []

  app.getSessionRecord = async (sessionId) => sessions.get(sessionId) || null
  app.updateSessionRecord = async (sessionId, patch) => {
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

  return { app, sessions, chunks }
}

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
