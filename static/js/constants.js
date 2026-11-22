// 传输协议与运行时常量。这些值参与线上协议（chunk 大小、信令超时等），
// 与后端/旧客户端保持兼容，修改前需要确认两端同时升级。
export const CHUNK_SIZE = 256 * 1024
export const DB_NAME = "web-transfer-db"
export const DB_VERSION = 1
export const SESSION_STORE = "sessions"
export const CHUNK_STORE = "chunks"
export const DEFAULT_ROOM_CODE = "DEFAULT"
export const DISPLAY_NAME_STORAGE_KEY = "web-transfer-display-name"
export const ROOM_CODE_STORAGE_KEY = "web-transfer-room-code"
export const MAX_BUFFERED_AMOUNT = 4 * 1024 * 1024
export const MAX_LOGS = 80
export const TERMINAL_SESSION_STATUSES = new Set(["completed", "rejected", "cancelled", "failed"])
export const RELAY_MAX_TRANSFER_BYTES = 64 * 1024 * 1024
export const IOS_SAFARI_MAX_INCOMING_BYTES = 1536 * 1024 * 1024
export const SESSION_PROGRESS_BATCH_SIZE = 32
export const INCOMING_SESSION_FLUSH_BATCH_SIZE = 32
export const INCOMING_SESSION_FLUSH_INTERVAL_MS = 500
export const MOBILE_SKIP_CHECKSUM_BYTES = 128 * 1024 * 1024
export const SESSION_RECEIVE_ACK_TIMEOUT_MS = 20000
// 聊天附件走 JSON+base64 分块（32KB 原始 ≈ 44KB 编码后单条消息），
// 兼容 DataChannel 单条消息上限（Chrome ~256KB、旧 Safari ~64KB）与中继通道，
// 且不与文件传输会话的二进制 chunk 流共享状态。
export const CHAT_FILE_CHUNK_SIZE = 32 * 1024
export const CHAT_FILE_MAX_BYTES = 16 * 1024 * 1024
export const CHAT_FILE_MAX_PENDING_BYTES = 20 * 1024 * 1024
export const CHAT_TEXT_COLLAPSE_CHARS = 500
export const CHAT_TEXT_COLLAPSE_LINES = 14
export const DEFAULT_ICE_SERVERS = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] },
]
