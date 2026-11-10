import { DownloadIcon } from './Icons'
import type { HdExport } from '../lib/useHdExport'

export default function ExportHd({ hd, resultsUrl, title }: { hd: HdExport; resultsUrl?: string; title: string }) {
  if (!hd.available) return null
  const base = 'flex h-9 pointer-coarse:h-11 items-center gap-2 rounded-full px-3 text-xs text-zinc-300 ring-1 ring-white/10 transition-colors hover:bg-white/5 hover:text-white'
  const url = hd.downloadUrl(resultsUrl, title)
  if (url) {
    return (
      <a href={url} className={`${base} text-amber-300`} title="Download the HD MP4">
        <DownloadIcon className="h-3.5 w-3.5" />
        Download HD
      </a>
    )
  }
  if (hd.state === 'working') {
    return (
      <span role="status" className={`${base} cursor-default`}>
        <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/15 border-t-amber-400 motion-reduce:animate-none" />
        <span className="sr-only">Making the HD file, the download starts when it is ready</span>
      </span>
    )
  }
  return (
    <button
      onClick={async () => {
        const err = await hd.start()
        if (err) alert(err)
      }}
      className={base}
      title="Make a 1080p or 720p MP4 you can download"
    >
      <DownloadIcon className="h-3.5 w-3.5" />
      {hd.state === 'failed' ? 'Retry HD' : 'Export HD'}
    </button>
  )
}
