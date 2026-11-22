import { TransferApp } from "./core/transfer-app.js"

export function createTransferApp(options = {}) {
  return new TransferApp(options)
}
