import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { search, type SearchHit } from '../api/client'
import Shell from '../components/Shell'
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
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let stopped = false
    setHits(null)
    setFailed(false)
    search(q)
      .then((r) => {
        if (!stopped) setHits(r)
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
      <h1 className="font-display text-3xl font-bold tracking-tight text-white">
        {q ? <>&ldquo;{q}&rdquo;</> : 'Search'}
      </h1>
      <p className="mb-6 mt-1 text-sm text-zinc-400">
        Moments where this was said, across all your videos{hits && hits.length > 0 ? ` (${hits.length})` : ''}. Click one to play from there.
      </p>
      {failed ? (
        <div className="glass rounded-3xl px-6 py-16 text-center text-red-300">Search failed. Check that the API is running, then try again.</div>
      ) : hits === null ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="shimmer h-24 rounded-3xl" />
          ))}
        </div>
      ) : hits.length === 0 ? (
        <div className="glass rounded-3xl px-6 py-16 text-center text-slate-400">Nobody says that in any of your videos. Try fewer or different words.</div>
      ) : (
        <motion.ul className="space-y-3" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.04 } } }}>
          {hits.map((h) => (
            <motion.li key={h.video_id + h.from_ms} variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }}>
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
                  <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-slate-200">{clock(h.from_ms / 1000)}</span>
                </div>
                <div className="min-w-0">
                  <p className="truncate text-xs text-slate-400">{h.title}</p>
                  <p className="mt-1 line-clamp-2 text-slate-200">
                    <Highlight text={h.text} terms={terms} />
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
