// 传输引擎统一出口：UI 与测试都从这里导入。
export { TransferApp } from "./core/transfer-app.js"
export { createTransferApp } from "./create.js"
export { collectInputFiles, collectDroppedFiles, buildViewUrl } from "./entry-helpers.js"
