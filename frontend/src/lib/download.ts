import type { Segment } from '../api/client'
import { clock } from './time'

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function fileName(title: string, ext: string) {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'transcript'
  return `${base}.${ext}`
}

export function transcriptText(segments: Segment[]) {
  return segments.map((s) => `[${clock(s.from_ms / 1000)}] ${s.text.trim()}`).join('\n') + '\n'
}

export async function downloadVtt(base: string, title: string) {
  const res = await fetch(base + 'transcript.vtt')
  if (!res.ok) throw new Error(`transcript.vtt: ${res.status}`)
  save(await res.blob(), fileName(title, 'vtt'))
}

export function downloadTxt(segments: Segment[], title: string) {
  save(new Blob([transcriptText(segments)], { type: 'text/plain' }), fileName(title, 'txt'))
}
