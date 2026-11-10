export function snippet(text: string, terms: string[], width = 140) {
  if (text.length <= width) return text
  const lower = text.toLowerCase()
  const at = Math.max(0, Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0), text.length))
  let start = Math.max(0, Math.min(at - Math.floor(width / 3), text.length - width))
  let end = Math.min(text.length, start + width)
  if (start > 0) {
    const space = text.indexOf(' ', start)
    if (space !== -1 && space < at) start = space + 1
  }
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end)
    if (space > at) end = space
  }
  return (start > 0 ? '... ' : '') + text.slice(start, end) + (end < text.length ? ' ...' : '')
}

export function firstAppearances<T extends { text: string }>(frames: T[], matches: (text: string) => boolean) {
  return frames.filter((f, i) => matches(f.text) && !(i > 0 && matches(frames[i - 1].text)))
}
