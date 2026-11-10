import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { search, type SearchResult } from '../api/client'
import AskCard from '../components/AskCard'
import ReelPlayer from '../components/ReelPlayer'
import Shell from '../components/Shell'
import { snippet } from '../lib/snippet'
import { clock, thumbFor } from '../lib/time'

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return <>{text}</>
  const pattern = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return (
    <>
      {text.split(pattern).map((part, i) =>
        i % 2 ? (
          <mark key={i} className="rounded bg-amber-400/30 px-0.5 text-white">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  )
}

export default function Search() {
  const [params] = useSearchParams()
  const q = params.get('q') ?? ''
  const [data, setData] = useState<SearchResult | null>(null)
  const hits = data?.results ?? null
  const short = q.trim().replace(/\s+/g, '').length < 2
  const asking = params.get('ask') === '1'
  const [reel, setReel] = useState(false)
  const videoCount = new Set(hits?.map((h) => h.video_id)).size
  const manyVideos = videoCount >= 2

  useEffect(() => setReel(false), [q])
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let stopped = false
    setData(null)
    setFailed(false)
    if (short) return
    search(q)
      .then((r) => {
        if (!stopped) setData(r)
      })
      .catch(() => {
        if (!stopped) setFailed(true)
      })
    return () => {
      stopped = true
    }
  }, [q])

  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)

  return (
    <Shell>
      <h1 className="font-display title-xl text-white">
        {q ? <>&ldquo;{q}&rdquo;</> : 'Search'}
      </h1>
      <p className="mt-1 text-sm text-zinc-400">
        {hits && hits.length > 0 && `${hits.length} ${hits.length === 1 ? 'moment' : 'moments'} in ${videoCount} ${videoCount === 1 ? 'video' : 'videos'}`}
      </p>
      <p className="mb-6 mt-1 text-sm text-zinc-500">
        {data && data.skipped.length > 0 && `Still processing, not searched yet: ${data.skipped.join(', ')}. `}
        {!short && !asking && 'Press Enter to get an AI answer from all your videos.'}
      </p>
      {hits && manyVideos && !reel && (
        <button onClick={() => setReel(true)} className="btn-glow mb-4 inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold">
          <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden>
            <path d="M8 5.5v13l10-6.5z" />
          </svg>
          Watch all {hits.length} moments
        </button>
      )}
      {reel && manyVideos && hits && <ReelPlayer hits={hits} onClose={() => setReel(false)} />}
      {!short && asking && <AskCard q={q.trim()} />}
      {short ? (
        <div className="glass rounded-3xl px-6 py-16 text-center text-zinc-400">Keep typing...</div>
      ) : failed ? (
        <div className="glass rounded-3xl px-6 py-16 text-center text-red-300">Search failed. Check that the API is running, then try again.</div>
      ) : hits === null ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="shimmer h-24 rounded-3xl" />
          ))}
        </div>
      ) : hits.length === 0 ? (
        <div className="glass rounded-3xl px-6 py-16 text-center text-zinc-400">Nobody says or shows that in any of your videos. Try fewer or different words.</div>
      ) : (
        <motion.ul className="space-y-3" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.04 } } }}>
          {hits.map((h) => (
            <motion.li key={h.kind + h.video_id + h.from_ms} variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }}>
              <Link
                to={`/videos/${h.video_id}?t=${Math.floor(h.from_ms / 1000)}`}
                className="glass group flex items-center gap-4 rounded-3xl p-2 pr-5 transition-colors hover:border-white/20"
              >
                <div className="relative aspect-video w-36 shrink-0 overflow-hidden rounded-2xl bg-black/40">
                  {h.results_url && (
                    <img
                      src={thumbFor(h.results_url, h.from_ms / 1000)}
                      alt=""
                      crossOrigin="anonymous"
                      onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
                      className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                    />
                  )}
                  <span className="absolute bottom-1.5 right-1.5 rounded bg-scrim/70 px-1.5 py-0.5 font-mono text-[10px] text-on-scrim">{clock(h.from_ms / 1000)}</span>
                </div>
                <div className="min-w-0">
                  <p className="truncate text-xs text-zinc-400">
                    {h.kind === 'screen' && <span className="mr-2 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-200">On screen</span>}
                    {h.title}
                  </p>
                  <p className="mt-1 line-clamp-2 text-zinc-200">
                    <Highlight text={snippet(h.text, terms)} terms={terms} />
                  </p>
                </div>
              </Link>
            </motion.li>
          ))}
        </motion.ul>
      )}
    </Shell>
  )
}
