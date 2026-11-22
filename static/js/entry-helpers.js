import { collectInputFiles, collectDroppedFiles } from "./utils/files.js"

export { collectInputFiles, collectDroppedFiles }

export function buildViewUrl(view, formState = {}) {
  const targetPath = view === "mobile" ? "/m" : "/"
  const url = new URL(targetPath, window.location.origin)
  url.searchParams.set("view", view)
  if (formState.roomCode) {
    url.searchParams.set("room", formState.roomCode)
  }
  if (formState.displayName) {
    url.searchParams.set("name", formState.displayName)
  }
  return `${url.pathname}${url.search}`
}
