export function pickSegments(variant: string, segmentDir: string, start: number, end: number) {
  const lines = variant.split('\n').map((l) => l.trim())
  const out: string[] = []
  let t = 0
  let first: number | null = null
  let length = 0
  let target = 1
  let gap = false
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '#EXT-X-DISCONTINUITY') gap = true
    if (!lines[i].startsWith('#EXTINF:')) continue
    const d = parseFloat(lines[i].slice(8))
    const uri = lines[i + 1]
    const segStart = t
    t += d
    i++
    if (t > start && segStart < end) {
      if (first === null) first = segStart
      else if (gap) out.push('#EXT-X-DISCONTINUITY')
      out.push(lines[i - 1], /^https?:/.test(uri) ? uri : segmentDir + uri)
      target = Math.max(target, Math.ceil(d))
      length += d
    }
    gap = false
  }
  if (first === null) return null
  return { lines: out, first, length, target }
}

export function playlistText(lines: string[], target: number) {
  return ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0', ...lines, '#EXT-X-ENDLIST', ''].join('\n')
}

export function clipPlaylist(variant: string, segmentDir: string, start: number, end: number) {
  const picked = pickSegments(variant, segmentDir, start, end)
  if (!picked) return null
  return { playlist: playlistText(picked.lines, picked.target), offset: start - picked.first }
}

export function blobURL(playlist: string) {
  return URL.createObjectURL(new Blob([playlist], { type: 'application/vnd.apple.mpegurl' }))
}

export async function loadVariant(base: string) {
  const master = await (await fetch(base + 'hls/master.m3u8')).text()
  const rendition = master.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'))
  if (!rendition) return null
  const variant = await (await fetch(base + 'hls/' + rendition)).text()
  return { variant, segmentDir: base + 'hls/' + rendition.replace(/[^/]*$/, '') }
}

export async function loadClip(base: string, start: number, end: number) {
  const v = await loadVariant(base)
  if (!v) return null
  const built = clipPlaylist(v.variant, v.segmentDir, start, end)
  if (!built) return null
  return { url: blobURL(built.playlist), offset: built.offset, length: end - start }
}
