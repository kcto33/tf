import { CHUNK_STORE, DB_NAME, DB_VERSION, SESSION_STORE } from "../constants.js"
import { makeChunkKey } from "../utils/id.js"

export function openDatabase() {
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

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

// 会话/分块两层 IndexedDB 存储：sessions 存元数据，chunks 按分块落盘用于续传。
// 表结构与历史版本保持一致（DB_VERSION=1），老用户升级后历史可继续使用。
export class SessionStore {
  constructor(db) {
    this.db = db
  }

  runTransaction(storeName, mode, work) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, mode)
      const store = tx.objectStore(storeName)
      const result = work(store)
      tx.oncomplete = async () => resolve(await result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
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

  async listRecentSessions(limit = 30) {
    const sessions = (await this.runTransaction(SESSION_STORE, "readonly", (store) => idbRequest(store.getAll()))) || []
    return sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, limit)
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

  makeChunkRecord({ sessionId, fileId, chunkIndex, data }) {
    return {
      chunkKey: makeChunkKey(sessionId, fileId, chunkIndex),
      sessionId,
      fileId,
      chunkIndex,
      data,
    }
  }

  async clearStore(storeName) {
    return this.runTransaction(storeName, "readwrite", (store) => store.clear())
  }

  async clearAll() {
    await this.clearStore(SESSION_STORE)
    await this.clearStore(CHUNK_STORE)
  }
}
