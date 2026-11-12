import { DownloadIcon } from './Icons'
import type { HdExport } from '../lib/useHdExport'

export default function ExportHd({ hd, resultsUrl, title }: { hd: HdExport; resultsUrl?: string; title: string }) {
  if (!hd.available) return null
  const base = 'flex h-9 pointer-coarse:h-11 items-center gap-2 rounded-outer px-3 text-xs text-ink-primary ring-1 ring-border-subtle transition-colors hover:bg-subtle hover:text-ink-primary'
  const url = hd.downloadUrl(resultsUrl, title)
  if (url) {
    return (
      <a href={url} className={`${base} text-accent`} title="Download the HD MP4">
        <DownloadIcon className="h-3.5 w-3.5" />
        Download HD
      </a>
    )
  }
  if (hd.state === 'working') {
    return (
      <span role="status" className={`${base} cursor-default`}>
        <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-border-subtle border-t-accent motion-reduce:animate-none" />
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
