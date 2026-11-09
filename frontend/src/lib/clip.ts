export function clipPlaylist(variant: string, segmentDir: string, start: number, end: number) {
  const lines = variant.split('\n').map((l) => l.trim())
  const out: string[] = []
  let t = 0
  let first: number | null = null
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
    }
    gap = false
  }
  if (first === null) return null
  const body = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0', ...out, '#EXT-X-ENDLIST', '']
  return { playlist: body.join('\n'), offset: start - first }
}

export async function loadClip(base: string, start: number, end: number) {
  const master = await (await fetch(base + 'hls/master.m3u8')).text()
  const rendition = master.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'))
  if (!rendition) return null
  const variant = await (await fetch(base + 'hls/' + rendition)).text()
  const built = clipPlaylist(variant, base + 'hls/' + rendition.replace(/[^/]*$/, ''), start, end)
  if (!built) return null
  return { url: URL.createObjectURL(new Blob([built.playlist], { type: 'application/vnd.apple.mpegurl' })), offset: built.offset, length: end - start }
}
