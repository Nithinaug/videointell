import { useEffect, useRef, useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import Hls from 'hls.js'
import { canDelete, deleteVideo, getProgress, getResults, getVideoDetail, type Progress, type Segment, type Results, type VideoDetail as VideoDetailT } from '../api/client'
import Shell from '../components/Shell'
import { clock, thumbFor, toSeconds } from '../lib/time'
import StatusBadge from '../components/StatusBadge'

const POLL_MS = 10_000

function Card({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={`glass rounded-3xl p-5 space-y-3 ${className}`}>
      <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">{title}</h2>
      {children}
    </section>
  )
}

function Chips({ items, tone }: { items: string[]; tone: 'sky' | 'slate' }) {
  if (items.length === 0) return <p className="text-sm text-slate-500">None found.</p>
  const color = tone === 'sky' ? 'bg-sky-400/10 text-sky-200 ring-sky-400/20' : 'bg-white/5 text-slate-300 ring-white/10'
  return (
    <ul className="flex flex-wrap gap-2">
      {items.map((item) => (
        <li key={item} className={`px-3 py-1 rounded-full text-xs ring-1 ${color}`}>{item}</li>
      ))}
    </ul>
  )
}

function ChapterStrip({
  base,
  chapters,
  time,
  duration,
  onSeek,
}: {
  base: string
  chapters: Results['summary']['chapters']
  time: number
  duration: number
  onSeek: (s: number) => void
}) {
  const starts = chapters.map((c) => toSeconds(c.start))
  const active = starts.reduce((current, s, i) => (s <= time ? i : current), -1)
  const activeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduce ? 'auto' : 'smooth' })
  }, [active])

  return (
    <nav aria-label="Chapters" className="fade-in flex gap-3 overflow-x-auto snap-x pb-2 -mx-4 px-4">
      {chapters.map((c, i) => {
        const end = starts[i + 1] ?? duration
        const progress = i < active ? 1 : i === active && end > starts[i] ? (time - starts[i]) / (end - starts[i]) : 0
        return (
          <button
            key={c.start + c.title}
            ref={i === active ? activeRef : undefined}
            aria-current={i === active}
            onClick={() => onSeek(starts[i])}
            className={`group snap-start shrink-0 w-44 text-left rounded-xl overflow-hidden ring-1 transition duration-200 ${
              i === active ? 'ring-sky-400/70 bg-sky-400/10' : 'ring-white/10 bg-white/[0.03] hover:ring-white/30'
            }`}
          >
            <div className="relative aspect-video bg-black">
              <img
                src={thumbFor(base, starts[i])}
                alt=""
                loading="lazy"
                crossOrigin="anonymous"
                onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
                className="w-full h-full object-cover opacity-80 transition-opacity group-hover:opacity-100"
              />
              <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/70 font-mono text-[10px] text-slate-200">
                {c.start}
              </span>
              <div className="absolute inset-x-0 bottom-0 h-0.5 bg-white/10">
                <div className="h-full bg-sky-400 transition-[width] duration-300" style={{ width: `${progress * 100}%` }} />
              </div>
            </div>
            <p className={`px-3 py-2 text-sm truncate ${i === active ? 'text-sky-100' : 'text-slate-300'}`}>{c.title}</p>
          </button>
        )
      })}
    </nav>
  )
}

function Step({ label, state, children }: { label: string; state: 'todo' | 'active' | 'done'; children?: ReactNode }) {
  return (
    <li className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <span
          className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold ring-1 transition-colors duration-300 ${
            state === 'done' ? 'bg-emerald-400/20 text-emerald-200 ring-emerald-400/40' : state === 'active' ? 'bg-violet-400/20 text-violet-100 ring-violet-400/50' : 'bg-white/5 text-slate-500 ring-white/10'
          }`}
        >
          {state === 'done' ? '\u2713' : state === 'active' ? <span className="pulse-dot h-2 w-2 rounded-full bg-violet-300" /> : ''}
        </span>
        <span className={`truncate text-sm ${state === 'todo' ? 'text-slate-500' : 'text-slate-200'}`}>{label}</span>
      </div>
      {children}
    </li>
  )
}

function Tracker({ videoId }: { videoId: string }) {
  const [p, setP] = useState<Progress | null>(null)

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const next = await getProgress(videoId)
        if (!stopped) setP(next)
      } catch {
        /* keep the last value */
      }
      if (!stopped) timer = setTimeout(poll, 3000)
    }
    poll()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [videoId])

  const claimed = p !== null && p.status !== 'uploaded'
  const chunksDone = p?.chunks ? p.chunks_done === p.chunks : false
  const state = (done: boolean, active: boolean) => (done ? 'done' : active ? 'active' : 'todo')

  return (
    <section aria-live="polite" className="glass rounded-3xl p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Pipeline</h2>
      </div>
      <ol className="flex flex-col gap-4 sm:flex-row">
        <Step label="Queued" state={state(claimed, !claimed)} />
        <Step label="Split" state={state(!!p?.split, claimed && !p?.split)} />
        <Step label={p?.chunks ? `Chunks ${p.chunks_done}/${p.chunks}` : 'Chunks'} state={state(chunksDone, !!p?.split && !chunksDone)}>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
            <motion.div
              className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400"
              animate={{ width: `${p?.chunks ? (p.chunks_done / p.chunks) * 100 : 0}%` }}
              transition={{ type: 'spring', stiffness: 90, damping: 20 }}
            />
          </div>
        </Step>
        <Step label="Labels" state={state(!!p?.labels, claimed && !p?.labels)} />
        <Step label="Stitch" state={state(!!p?.assembled, chunksDone && !p?.assembled)} />
        <Step label="Summary" state={state(!!p?.summary, !!p?.assembled && !p?.summary)} />
      </ol>
    </section>
  )
}

function Skeleton({ videoId }: { videoId: string }) {
  return (
    <div aria-busy="true" aria-label="Processing video" className="space-y-6">
      <Tracker videoId={videoId} />
      <div className="flex gap-3 overflow-hidden">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="shrink-0 w-44 space-y-2">
            <div className="shimmer aspect-video rounded-xl" />
            <div className="shimmer h-3 w-3/4 rounded" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
        <div className="glass rounded-3xl p-5 space-y-3">
          <div className="shimmer h-3 w-20 rounded" />
          <div className="shimmer h-4 w-full rounded" />
          <div className="shimmer h-4 w-5/6 rounded" />
          <div className="shimmer h-4 w-2/3 rounded" />
        </div>
        <div className="glass rounded-3xl p-5 space-y-3">
          <div className="shimmer h-3 w-16 rounded" />
          <div className="flex gap-2">
            <div className="shimmer h-6 w-14 rounded-full" />
            <div className="shimmer h-6 w-20 rounded-full" />
          </div>
        </div>
      </div>
    </div>
  )
}

function Transcript({ segments, time, onSeek }: { segments: Segment[]; time: number; onSeek: (s: number) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)
  const ms = time * 1000
  const active = segments.reduce((current, s, i) => (s.from_ms <= ms ? i : current), -1)

  useEffect(() => {
    const el = activeRef.current
    const container = box.current
    if (!el || !container) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    container.scrollTo({ top: el.offsetTop - container.clientHeight / 3, behavior: reduce ? 'auto' : 'smooth' })
  }, [active])

  if (segments.length === 0) return null
  return (
    <Card title="Transcript">
      <div ref={box} className="relative -mx-2 max-h-80 overflow-y-auto pr-1">
        {segments.map((s, i) => (
          <button
            key={s.from_ms + s.text}
            ref={i === active ? activeRef : undefined}
            aria-current={i === active}
            onClick={() => onSeek(s.from_ms / 1000)}
            className={`flex w-full gap-3 rounded-xl px-2 py-1.5 text-left text-sm transition-colors duration-200 ${
              i === active ? 'bg-violet-400/15 text-white' : 'text-slate-300 hover:bg-white/5'
            }`}
          >
            <span className="w-12 shrink-0 pt-0.5 font-mono text-xs text-slate-500">{clock(s.from_ms / 1000)}</span>
            <span>{s.text}</span>
          </button>
        ))}
      </div>
    </Card>
  )
}

function Watch({ detail, results, startAt }: { detail: VideoDetailT; results: Results | null; startAt: number }) {
  const ref = useRef<HTMLVideoElement>(null)
  const started = useRef(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const base = results ? detail.results_url : undefined
  const poster = base ? base + 'thumbs/thumb_01.jpg' : undefined

  useEffect(() => {
    const video = ref.current
    if (!video) return
    if (!base) {
      video.src = detail.url ?? ''
      return
    }
    const src = base + 'hls/master.m3u8'
    if (video.canPlayType('application/vnd.apple.mpegurl') || !Hls.isSupported()) {
      video.src = src
      return
    }
    const hls = new Hls()
    hls.loadSource(src)
    hls.attachMedia(video)
    return () => hls.destroy()
  }, [base, detail.url])

  function seek(seconds: number) {
    const video = ref.current
    if (!video) return
    video.currentTime = seconds
    video.play()
  }

  return (
    <>
      <motion.div layoutId={`media-${detail.video.id}`} className="relative">
        {poster && (
          <img src={poster} alt="" aria-hidden className="absolute inset-0 w-full h-full object-cover blur-3xl opacity-30 scale-110 pointer-events-none" />
        )}
        <video
          ref={ref}
          controls
          crossOrigin="anonymous"
          poster={poster}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => {
            setDuration(e.currentTarget.duration)
            if (startAt > 0 && base && !started.current) {
              started.current = true
              e.currentTarget.currentTime = startAt
              e.currentTarget.play().catch(() => {})
            }
          }}
          className="relative w-full aspect-video max-h-[62vh] object-contain rounded-3xl bg-black ring-1 ring-white/15 shadow-[0_30px_80px_-20px_rgba(139,92,246,0.45)]"
        >
          {base && <track kind="captions" srcLang="en" label="English" src={base + 'transcript.vtt'} />}
        </video>
      </motion.div>

      {!results ? (
        <Skeleton videoId={detail.video.id} />
      ) : (
        <>
          {base && results.summary.chapters.length > 0 && (
            <ChapterStrip base={base} chapters={results.summary.chapters} time={time} duration={duration} onSeek={seek} />
          )}
          <div className="fade-in grid gap-4 md:grid-cols-[2fr_1fr]">
            <div className="space-y-4">
              <Card title="Summary">
                <p className="text-slate-200 leading-relaxed">{results.summary.summary || 'No speech found in this video.'}</p>
              </Card>
              <Transcript segments={results.transcript} time={time} onSeek={seek} />
            </div>
            <div className="space-y-4">
              <Card title="Tags">
                <Chips items={results.summary.tags} tone="sky" />
              </Card>
              <Card title="Seen in the video">
                <Chips items={results.labels} tone="slate" />
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  )
}

export default function VideoDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const startAt = Number(params.get('t')) || 0
  const [deleting, setDeleting] = useState(false)
  const [detail, setDetail] = useState<VideoDetailT | null>(null)
  const [results, setResults] = useState<Results | null>(null)

  useEffect(() => {
    if (!id) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    async function load() {
      const d = await getVideoDetail(id!)
      const r = d.results_url ? await getResults(d.results_url) : null
      if (stopped) return
      setDetail((prev) => (prev && !r ? { ...prev, video: d.video } : d))
      if (r) setResults(r)
      else if (d.video.status !== 'failed') timer = setTimeout(load, POLL_MS)
    }
    load()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [id])

  if (!detail) {
    return (
      <Shell>
        <div className="shimmer aspect-video rounded-3xl" />
      </Shell>
    )
  }

  const { video } = detail

  async function onDelete() {
    if (!confirm(`Delete "${video.title}"? This removes the video, its results and its record for good.`)) return
    setDeleting(true)
    try {
      await deleteVideo(video.id)
      navigate('/', { replace: true })
    } catch {
      setDeleting(false)
      alert('Could not delete the video. Try again.')
    }
  }

  return (
    <Shell>
      <div className="space-y-6">
        <header className="space-y-3">
          <Link to="/" className="inline-flex items-center gap-1 text-sm text-slate-400 transition-colors hover:text-white">
            &larr; Videos
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-3xl md:text-4xl font-bold tracking-tight text-white">{video.title}</h1>
            <StatusBadge status={video.status} />
            {canDelete(video.status) && (
              <button
                onClick={onDelete}
                disabled={deleting}
                className="ml-auto rounded-xl px-3 py-2 text-sm text-slate-300 ring-1 ring-white/10 transition-colors hover:bg-red-500/15 hover:text-red-200 hover:ring-red-400/40 disabled:opacity-50"
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            )}
          </div>
          <p className="text-xs text-slate-500">{new Date(video.created_at).toLocaleString()}</p>
        </header>

        {!detail.url ? (
          <div className="glass rounded-3xl p-6 text-sm text-slate-400">Upload still in progress...</div>
        ) : video.status === 'failed' ? (
          <div className="glass rounded-3xl border-red-400/30 p-6 text-sm text-red-300">Processing failed.</div>
        ) : (
          <Watch detail={detail} results={results} startAt={startAt} />
        )}
      </div>
    </Shell>
  )
}
