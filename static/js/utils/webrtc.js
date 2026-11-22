import { MAX_BUFFERED_AMOUNT } from "../constants.js"

export function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export function serializeIceCandidate(candidate) {
  if (!candidate) {
    return null
  }
  if (typeof candidate.toJSON === "function") {
    return candidate.toJSON()
  }
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment,
  }
}

export function deserializeIceCandidate(candidate) {
  if (!candidate) {
    return null
  }
  if (typeof RTCIceCandidate === "function") {
    return new RTCIceCandidate(candidate)
  }
  return candidate
}

export async function waitForChannelOpen(connection) {
  if (connection.channel && connection.channel.readyState === "open") {
    return
  }
  await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("等待传输通道超时。")), 12000)
    const timer = window.setInterval(() => {
      if (connection.channel && connection.channel.readyState === "open") {
        window.clearTimeout(timeout)
        window.clearInterval(timer)
        resolve()
      }
    }, 200)
  })
}

export async function waitForBufferedAmount(channel, nextSize) {
  if (channel.bufferedAmount + nextSize <= MAX_BUFFERED_AMOUNT) {
    return
  }
  await new Promise((resolve) => {
    let settled = false
    const lowThreshold = Math.max(MAX_BUFFERED_AMOUNT - nextSize, 0)
    const cleanup = () => {
      if (settled) {
        return
      }
      settled = true
      if (typeof channel.removeEventListener === "function") {
        channel.removeEventListener("bufferedamountlow", onBufferedAmountLow)
      }
      window.clearInterval(timer)
      resolve()
    }
    const onBufferedAmountLow = () => {
      if (channel.bufferedAmount + nextSize <= MAX_BUFFERED_AMOUNT) {
        cleanup()
      }
    }

    try {
      channel.bufferedAmountLowThreshold = lowThreshold
    } catch (error) {
      void error
    }
    if (typeof channel.addEventListener === "function") {
      channel.addEventListener("bufferedamountlow", onBufferedAmountLow)
    }
    const timer = window.setInterval(onBufferedAmountLow, 80)
    onBufferedAmountLow()
  })
}
