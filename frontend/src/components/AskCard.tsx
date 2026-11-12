import { motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ask, type AskResult } from '../api/client'
import { snippet } from '../lib/snippet'
import { clock } from '../lib/time'

export default function AskCard({ q, videoId, onSeek }: { q: string; videoId?: string; onSeek?: (seconds: number) => void }) {
  const [data, setData] = useState<AskResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const where = videoId ? 'this video' : 'your videos'
  const box = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!data && !error) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    box.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  }, [data, error])

  useEffect(() => {
    let stopped = false
    setData(null)
    setError(null)
    ask(q, videoId)
      .then((r) => !stopped && setData(r))
      .catch((err: unknown) => {
        const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        if (!stopped) setError(msg ?? 'Could not get an answer. Try again.')
      })
    return () => {
      stopped = true
    }
  }, [q, videoId])

  return (
    <motion.section ref={box} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="glass mb-4 rounded-outer p-5 scroll-mt-4" aria-live="polite">
      <h2 className="font-mono text-xs font-medium uppercase tracking-[0.08em] text-accent">Answer from {where}</h2>
      {error ? (
        <p className="mt-3 text-sm text-danger">{error}</p>
      ) : !data ? (
        <div className="mt-3 space-y-2">
          <div className="shimmer h-4 w-3/4 rounded" />
          <div className="shimmer h-4 w-1/2 rounded" />
        </div>
      ) : !data.answer ? (
        <p className="mt-3 text-sm text-ink-muted">Couldn't find an answer in {where}. Try other words, or check the matches below.</p>
      ) : (
        <>
          <p className="mt-3 leading-relaxed text-ink-primary">{data.answer}</p>
          <ul className="mt-4 space-y-1.5">
            {data.sources.map((s) => {
              const label = (
                <>
                  <span className="w-12 shrink-0 font-mono text-xs text-accent">{clock(s.from_ms / 1000)}</span>
                  <span className="min-w-0">
                    {s.kind === 'screen' && <span className="mr-2 rounded bg-subtle px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ink-primary">On screen</span>}
                    {!videoId && <span className="mr-2 text-xs text-ink-muted">{s.title}</span>}
                    <span className="text-ink-primary">{snippet(s.text, q.toLowerCase().split(/\s+/).filter(Boolean))}</span>
                  </span>
                </>
              )
              const cls = 'flex w-full gap-3 rounded-outer px-2 py-1.5 text-left text-sm transition-colors hover:bg-subtle'
              return (
                <li key={s.video_id + s.from_ms}>
                  {onSeek ? (
                    <button onClick={() => onSeek(s.from_ms / 1000)} className={cls}>
                      {label}
                    </button>
                  ) : (
                    <Link to={`/videos/${s.video_id}?t=${Math.floor(s.from_ms / 1000)}`} className={cls}>
                      {label}
                    </Link>
                  )}
                </li>
              )
            })}
          </ul>
          {data.truncated && <p className="mt-3 text-xs text-ink-muted">Only part of the transcript fit in the question, so the answer may miss something.</p>}
        </>
      )}
    </motion.section>
  )
}
