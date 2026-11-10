import { blobURL, loadVariant, pickSegments, playlistText } from './clip'

export interface Moment {
  videoId: string
  title: string
  base: string
  at: number
}

export interface ReelMark {
  videoId: string
  title: string
  at: number
  start: number
}

const BEFORE = 2
const AFTER = 12

export function windows(moments: Moment[]) {
  const out: { videoId: string; title: string; base: string; start: number; end: number; at: number }[] = []
  for (const m of moments) {
    const start = Math.max(0, m.at - BEFORE)
    const end = m.at + AFTER
    const last = out[out.length - 1]
    if (last && last.videoId === m.videoId && start <= last.end) {
      last.end = Math.max(last.end, end)
      continue
    }
    out.push({ videoId: m.videoId, title: m.title, base: m.base, start, end, at: m.at })
  }
  return out
}

export function joinReel(parts: { lines: string[]; length: number; target: number }[]) {
  const lines: string[] = []
  const starts: number[] = []
  let t = 0
  let target = 1
  parts.forEach((p, i) => {
    if (i > 0) lines.push('#EXT-X-DISCONTINUITY')
    starts.push(t)
    lines.push(...p.lines)
    t += p.length
    target = Math.max(target, p.target)
  })
  return { playlist: playlistText(lines, target), starts, length: t }
}

export async function buildReel(moments: Moment[]) {
  const ws = windows(moments)
  const variants = new Map<string, Awaited<ReturnType<typeof loadVariant>>>()
  const parts: { lines: string[]; length: number; target: number }[] = []
  const marks: ReelMark[] = []
  for (const w of ws) {
    if (!variants.has(w.videoId)) variants.set(w.videoId, await loadVariant(w.base).catch(() => null))
    const v = variants.get(w.videoId)
    if (!v) continue
    const picked = pickSegments(v.variant, v.segmentDir, w.start, w.end)
    if (!picked) continue
    parts.push(picked)
    marks.push({ videoId: w.videoId, title: w.title, at: w.at, start: 0 })
  }
  if (parts.length === 0) return null
  const joined = joinReel(parts)
  joined.starts.forEach((s, i) => (marks[i].start = s))
  return { url: blobURL(joined.playlist), marks, length: joined.length }
}
