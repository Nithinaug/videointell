import Hls from 'hls.js'
import { motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { SearchHit } from '../api/client'
import { buildReel, type Moment, type ReelMark } from '../lib/reel'
import { clock } from '../lib/time'

function moments(hits: SearchHit[]): Moment[] {
  const order = new Map<string, number>()
  hits.forEach((h) => order.has(h.video_id) || order.set(h.video_id, order.size))
  return hits
    .filter((h) => h.results_url)
    .map((h) => ({ videoId: h.video_id, title: h.title, base: h.results_url!, at: h.from_ms / 1000 }))
    .sort((a, b) => order.get(a.videoId)! - order.get(b.videoId)! || a.at - b.at)
}

export default function ReelPlayer({ hits, onClose }: { hits: SearchHit[]; onClose: () => void }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [marks, setMarks] = useState<ReelMark[] | null>(null)
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const video = ref.current
    if (!video) return
    if (!Hls.isSupported()) {
      setError('Reels need Chrome, Edge or Firefox for now.')
      return
    }
    let hls: Hls | null = null
    let url = ''
    let stopped = false
    buildReel(moments(hits))
      .then((r) => {
        if (stopped) return
        if (!r) return setError('Could not build a reel from these results.')
        url = r.url
        setMarks(r.marks)
        hls = new Hls()
        hls.loadSource(r.url)
        hls.attachMedia(video)
        hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}))
      })
      .catch(() => !stopped && setError('Could not build a reel from these results.'))
    return () => {
      stopped = true
      hls?.destroy()
      if (url) URL.revokeObjectURL(url)
    }
  }, [hits])

  function jump(i: number) {
    const video = ref.current
    if (!video || !marks || i < 0 || i >= marks.length) return
    video.currentTime = marks[i].start + 0.05
    video.play().catch(() => {})
  }

  const mark = marks?.[index]

  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="glass mb-6 space-y-3 rounded-2xl p-3" aria-label="Highlight reel">
      <video
        ref={ref}
        controls
        crossOrigin="anonymous"
        onTimeUpdate={(e) => {
          if (!marks) return
          const t = e.currentTarget.currentTime
          setIndex(marks.reduce((cur, m, i) => (m.start <= t ? i : cur), 0))
        }}
        className="w-full aspect-video rounded-xl bg-black object-contain"
      />
      <div className="flex items-center gap-2 px-1 text-sm">
        <button onClick={() => jump(index - 1)} disabled={!marks || index === 0} aria-label="Previous moment" className="rounded-lg px-2 py-1 text-zinc-300 ring-1 ring-white/10 hover:bg-white/5 disabled:opacity-30">
          &larr;
        </button>
        <button onClick={() => jump(index + 1)} disabled={!marks || index >= marks.length - 1} aria-label="Next moment" className="rounded-lg px-2 py-1 text-zinc-300 ring-1 ring-white/10 hover:bg-white/5 disabled:opacity-30">
          &rarr;
        </button>
        <p className="min-w-0 flex-1 truncate text-zinc-400" aria-live="polite">
          {error ??
            (mark ? (
              <>
                <span className="tabular-nums text-zinc-200">
                  Moment {index + 1} of {marks!.length}
                </span>
                {' · '}
                <Link to={`/videos/${mark.videoId}?t=${Math.floor(mark.at)}`} className="text-amber-300 hover:text-amber-200">
                  {mark.title} at {clock(mark.at)}
                </Link>
              </>
            ) : (
              'Building the reel...'
            ))}
        </p>
        <button onClick={onClose} aria-label="Close reel" className="rounded-lg px-2 py-1 text-zinc-400 hover:bg-white/5 hover:text-white">
          Close
        </button>
      </div>
    </motion.section>
  )
}
