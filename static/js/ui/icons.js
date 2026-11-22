// 内联 SVG 图标：24x24 网格，描边风格，跟随 currentColor。
const svg = (paths, viewBox = "0 0 24 24") =>
  `<svg viewBox="${viewBox}" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`

export const icons = {
  logo: svg(
    '<path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />'
  ),
  device: svg(
    '<rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8" /><path d="M12 16v4" />'
  ),
  file: svg(
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" />'
  ),
  folder: svg(
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />'
  ),
  send: svg('<path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" />'),
  chat: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />'),
  history: svg('<circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />'),
  activity: svg('<path d="M22 12h-4l-3 9L9 3l-3 9H2" />'),
  trash: svg('<path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />'),
  close: svg('<path d="M18 6 6 18" /><path d="m6 6 12 12" />'),
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" />'),
  check: svg('<path d="M20 6 9 17l-5-5" />'),
  link: svg('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L12 19" />'),
  uploadCloud: svg(
    '<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2" /><path d="M12 12v9" /><path d="m8 16 4-4 4 4" />'
  ),
  inbox: svg(
    '<path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z" />'
  ),
  message: svg('<path d="m7 9 3 3-3 3" /><rect x="2" y="4" width="20" height="16" rx="2" />'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2" />'),
  paperclip: svg(
    '<path d="m21.4 11.1-9.2 9.2a5 5 0 0 1-7.1-7.1l9.2-9.2a3.3 3.3 0 0 1 4.7 4.7l-9.2 9.2a1.7 1.7 0 0 1-2.4-2.4l8.5-8.5" />'
  ),
  chevron: svg('<path d="m6 9 6 6 6-6" />'),
}
