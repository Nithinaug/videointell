import { motion } from 'motion/react'
import { useState, type MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import { canDelete, deleteVideo, type Video } from '../api/client'
import StatusBadge from './StatusBadge'

export default function VideoCard({ video, big = false, onDeleted }: { video: Video; big?: boolean; onDeleted: () => void }) {
  const [thumbOk, setThumbOk] = useState(true)
  const [deleting, setDeleting] = useState(false)

  async function onDelete(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (!confirm(`Delete "${video.title}"? This removes the video, its clips and its results for good.`)) return
    setDeleting(true)
    const done = deleteVideo(video.id)
    onDeleted()
    try {
      await done
    } catch {
      alert(`Could not delete "${video.title}". It will show up again; try once more.`)
    }
  }
  const thumb = video.results_url && thumbOk ? `${video.results_url}thumbs/thumb_01.jpg` : null

  return (
    <div className="h-full">
      <Link
        to={`/videos/${video.id}`}
        className="group glass lift relative flex h-full flex-col overflow-hidden rounded-3xl p-2"
      >
        <motion.div layoutId={`media-${video.id}`} className={`relative overflow-hidden rounded-2xl bg-black/40 aspect-video ${big ? 'sm:aspect-auto sm:flex-1' : ''}`}>
          {thumb ? (
            <img src={thumb} alt="" crossOrigin="anonymous" onError={() => setThumbOk(false)} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />
          ) : (
            <div className="h-full w-full bg-white/[0.03]" />
          )}
          <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-scrim/70 to-transparent" />
          <div className="absolute left-3 top-3">
            <StatusBadge status={video.status} />
          </div>
          {canDelete(video.status) && (
            <button
              onClick={onDelete}
              disabled={deleting}
              aria-label={`Delete ${video.title}`}
              className="absolute right-3 top-3 grid h-8 w-8 pointer-coarse:size-11 place-items-center rounded-full bg-scrim/50 text-on-scrim opacity-0 pointer-coarse:opacity-100 ring-1 ring-on-scrim/15 backdrop-blur transition hover:bg-red-500/80 hover:text-on-scrim focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-60"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
              </svg>
            </button>
          )}
        </motion.div>
        <div className="relative flex items-end justify-between gap-2 px-2 pb-1.5 pt-3">
          <div className="min-w-0">
            <h3 className={`font-display font-semibold text-white truncate ${big ? 'text-xl' : 'text-base'}`}>{video.title}</h3>
            <p className="mt-0.5 text-xs text-zinc-400">{new Date(video.created_at).toLocaleString()}</p>
          </div>
          <span className="shrink-0 text-zinc-500 transition-transform duration-300 group-hover:translate-x-1 group-hover:text-white" aria-hidden>
            &rarr;
          </span>
        </div>
      </Link>
    </div>
  )
}
