// 无压缩（stored）ZIP 打包器。接收端把多个文件合并成一个 zip 供浏览器下载。
// 只写本地文件头 + 中央目录 + 结束记录，所有字段使用 DOS 时间 0（合法）。
export function createStoredZip(entries) {
  const encoder = new TextEncoder()
  const files = entries.map((entry) => {
    const nameBytes = encoder.encode(entry.name.replaceAll("\\", "/"))
    const crc = crc32(entry.bytes)
    return {
      nameBytes,
      data: entry.bytes,
      crc,
    }
  })

  let offset = 0
  const localParts = []
  const centralParts = []

  for (const file of files) {
    const localHeader = new Uint8Array(30 + file.nameBytes.length)
    const localView = new DataView(localHeader.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(8, 0, true)
    localView.setUint16(10, 0, true)
    localView.setUint32(14, file.crc, true)
    localView.setUint32(18, file.data.length, true)
    localView.setUint32(22, file.data.length, true)
    localView.setUint16(26, file.nameBytes.length, true)
    localHeader.set(file.nameBytes, 30)
    localParts.push(localHeader, file.data)

    const centralHeader = new Uint8Array(46 + file.nameBytes.length)
    const centralView = new DataView(centralHeader.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(10, 0, true)
    centralView.setUint16(12, 0, true)
    centralView.setUint32(16, file.crc, true)
    centralView.setUint32(20, file.data.length, true)
    centralView.setUint32(24, file.data.length, true)
    centralView.setUint16(28, file.nameBytes.length, true)
    centralView.setUint32(42, offset, true)
    centralHeader.set(file.nameBytes, 46)
    centralParts.push(centralHeader)

    offset += localHeader.length + file.data.length
  }

  const centralSize = centralParts.reduce((sum, item) => sum + item.length, 0)
  const endRecord = new Uint8Array(22)
  const endView = new DataView(endRecord.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, files.length, true)
  endView.setUint16(10, files.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, offset, true)

  return new Blob([...localParts, ...centralParts, endRecord], { type: "application/zip" })
}

export function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let j = 0; j < 8; j += 1) {
      value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[i] = value >>> 0
  }
  return table
})()
