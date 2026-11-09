const THUMB_EVERY_S = 10

export function toSeconds(hms: string) {
  return hms.split(':').reduce((total, part) => total * 60 + Number(part), 0)
}

export function clock(seconds: number) {
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor(s / 60) % 60).padStart(h ? 2 : 1, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function thumbFor(base: string, seconds: number) {
  const n = Math.floor(seconds / THUMB_EVERY_S) + 1
  return `${base}thumbs/thumb_${String(n).padStart(2, '0')}.jpg`
}
