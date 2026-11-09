export function snippet(text: string, terms: string[], width = 140) {
  if (text.length <= width) return text
  const lower = text.toLowerCase()
  const at = Math.max(0, Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0), text.length))
  const start = Math.max(0, Math.min(at - Math.floor(width / 3), text.length - width))
  const cut = text.slice(start, start + width)
  return (start > 0 ? '... ' : '') + cut + (start + width < text.length ? ' ...' : '')
}

export function firstAppearances<T extends { text: string }>(frames: T[], matches: (text: string) => boolean) {
  return frames.filter((f, i) => matches(f.text) && !(i > 0 && matches(frames[i - 1].text)))
}
