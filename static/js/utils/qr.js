// 二维码生成：包装 vendored 的 qrcode-generator（MIT，见 vendor/qrcode.mjs 头部）。
// 自动选择最小版本，纠错级别 M，适合扫描场景。
import qrcode from "../vendor/qrcode.mjs"

export function createQrMatrix(text) {
  const qr = qrcode(0, "M")
  qr.addData(String(text || ""), "Byte")
  qr.make()
  const size = qr.getModuleCount()
  const matrix = []
  for (let row = 0; row < size; row += 1) {
    const line = []
    for (let col = 0; col < size; col += 1) {
      line.push(qr.isDark(row, col))
    }
    matrix.push(line)
  }
  return { size, matrix }
}

// 渲染到 canvas：白底 + 静区（4 模块），深色模块用近黑色保证对比度。
export function drawQrToCanvas(canvas, text, scale = 6) {
  const { size, matrix } = createQrMatrix(text)
  const quiet = 4
  const total = (size + quiet * 2) * scale
  canvas.width = total
  canvas.height = total
  const ctx = canvas.getContext("2d")
  ctx.fillStyle = "#ffffff"
  ctx.fillRect(0, 0, total, total)
  ctx.fillStyle = "#111827"
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (matrix[row][col]) {
        ctx.fillRect((col + quiet) * scale, (row + quiet) * scale, scale, scale)
      }
    }
  }
  return total
}
