// 传输被取消时用这个错误类型中断发送流水线；上层据此区分“取消”与“故障”。
export class TransferCancelledError extends Error {
  constructor(message) {
    super(message)
    this.name = "TransferCancelledError"
  }
}
