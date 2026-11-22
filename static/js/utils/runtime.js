export function detectRuntimeCapabilities() {
  const userAgent = navigator.userAgent || ""
  const isIPhone = /iPhone/i.test(userAgent)
  const isIPad = /iPad/i.test(userAgent) || (/Macintosh/i.test(userAgent) && "ontouchend" in document)
  const isAndroid = /Android/i.test(userAgent)
  const isWebKit = /AppleWebKit/i.test(userAgent)
  const isCriOS = /CriOS/i.test(userAgent)
  const isFxiOS = /FxiOS/i.test(userAgent)
  const isEdgiOS = /EdgiOS/i.test(userAgent)
  const isIOSSafari = (isIPhone || isIPad) && isWebKit && !isCriOS && !isFxiOS && !isEdgiOS
  const isIOSWebKitBrowser = (isIPhone || isIPad) && isWebKit
  return {
    isAndroid,
    isIOSSafari,
    isIOSWebKitBrowser,
    isMobileBrowser: isIPhone || isIPad || isAndroid,
  }
}
