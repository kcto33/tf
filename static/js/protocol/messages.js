import { CHUNK_SIZE, TERMINAL_SESSION_STATUSES } from "../constants.js"

export function isTerminalSessionStatus(status) {
  return TERMINAL_SESSION_STATUSES.has(status)
}

// 发送给对端/存入历史时剥离 File 句柄，只保留协议字段。
export function stripFileHandle(fileMeta) {
  return {
    file_id: fileMeta.file_id,
    relative_path: fileMeta.relative_path,
    size: fileMeta.size,
    sha256: fileMeta.sha256,
    chunk_size: fileMeta.chunk_size,
    chunk_count: fileMeta.chunk_count,
  }
}

export function objectToSets(completedChunks = {}) {
  const result = {}
  for (const [fileId, indices] of Object.entries(completedChunks || {})) {
    result[fileId] = new Set(indices)
  }
  return result
}

export function setsToObject(completedSets = {}) {
  const result = {}
  for (const [fileId, set] of Object.entries(completedSets)) {
    result[fileId] = Array.from(set).sort((a, b) => a - b)
  }
  return result
}

export function calculateIncomingProgress(filesMeta, completedSets) {
  let done = 0
  let total = 0
  for (const fileMeta of filesMeta) {
    total += fileMeta.size
    const set = completedSets[fileMeta.file_id] || new Set()
    const chunkSize = fileMeta.chunk_size || fileMeta.chunkSize || CHUNK_SIZE
    for (const index of set) {
      const start = index * chunkSize
      const end = Math.min(start + chunkSize, fileMeta.size)
      done += end - start
    }
  }
  return { done, total }
}
