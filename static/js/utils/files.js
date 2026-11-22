export function collectInputFiles(fileList, { allowMultipleFiles = true } = {}) {
  const files = Array.from(fileList || []).map((file) => ({
    file,
    relativePath: file.webkitRelativePath || file.name,
  }))
  return allowMultipleFiles ? files : files.slice(0, 1)
}

export async function collectDroppedFiles(dataTransfer, { allowMultipleFiles = true } = {}) {
  const items = Array.from((dataTransfer && dataTransfer.items) || [])
  if (!items.length) {
    return collectInputFiles((dataTransfer && dataTransfer.files) || [], { allowMultipleFiles })
  }

  const allFiles = []
  for (const item of items) {
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null
    if (entry) {
      allFiles.push(...(await walkEntry(entry)))
    } else {
      const file = item.getAsFile ? item.getAsFile() : null
      if (file) {
        allFiles.push({ file, relativePath: file.name })
      }
    }
    if (!allowMultipleFiles && allFiles.length) {
      return allFiles.slice(0, 1)
    }
  }
  return allowMultipleFiles ? allFiles : allFiles.slice(0, 1)
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.rel = "noopener"
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function walkEntry(entry, prefix = "") {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file) => resolve([{ file, relativePath: prefix + file.name }]))
      return
    }
    if (!entry.isDirectory) {
      resolve([])
      return
    }

    const reader = entry.createReader()
    const collected = []
    const readBatch = () => {
      reader.readEntries(async (entries) => {
        if (!entries.length) {
          resolve(collected)
          return
        }
        for (const child of entries) {
          collected.push(...(await walkEntry(child, `${prefix}${entry.name}/`)))
        }
        readBatch()
      })
    }
    readBatch()
  })
}
