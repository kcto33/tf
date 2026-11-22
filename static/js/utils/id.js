function randomBytes(length) {
  const bytes = new Uint8Array(length)
  if (globalThis.crypto && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  return bytes
}

export function makeDefaultDisplayName() {
  const suffix = Array.from(randomBytes(3), (item) => item.toString(16).padStart(2, "0")).join("").toUpperCase()
  return `设备-${suffix}`
}

export function makeId() {
  if (globalThis.crypto && globalThis.crypto.randomUUID) {
    return globalThis.crypto.randomUUID()
  }

  const bytes = randomBytes(16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (item) => item.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function makeChunkKey(sessionId, fileId, chunkIndex) {
  return `${sessionId}:${fileId}:${chunkIndex}`
}
