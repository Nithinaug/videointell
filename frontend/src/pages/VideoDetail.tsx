import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import Hls from 'hls.js'
import { getResults, getVideoDetail, type Results, type VideoDetail as VideoDetailT } from '../api/client'
import StatusBadge from '../components/StatusBadge'

const POLL_MS = 10_000
const THUMB_EVERY_S = 10
const MAX_THUMBS = 10

function toSeconds(hms: string) {
  return hms.split(':').reduce((total, part) => total * 60 + Number(part), 0)
}

function thumbFor(base: string, seconds: number) {
  const n = Math.min(Math.floor(seconds / THUMB_EVERY_S) + 1, MAX_THUMBS)
  return `${base}thumbs/thumb_${String(n).padStart(2, '0')}.jpg`
}

function Card({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur p-5 space-y-3 ${className}`}>
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

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Processing video" className="space-y-6">
      <div className="flex gap-3 overflow-hidden">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="shrink-0 w-44 space-y-2">
            <div className="shimmer aspect-video rounded-xl" />
            <div className="shimmer h-3 w-3/4 rounded" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
        <div className="rounded-2xl border border-white/10 p-5 space-y-3">
          <div className="shimmer h-3 w-20 rounded" />
          <div className="shimmer h-4 w-full rounded" />
          <div className="shimmer h-4 w-5/6 rounded" />
          <div className="shimmer h-4 w-2/3 rounded" />
        </div>
        <div className="rounded-2xl border border-white/10 p-5 space-y-3">
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

function Watch({ detail, results }: { detail: VideoDetailT; results: Results | null }) {
  const ref = useRef<HTMLVideoElement>(null)
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
      <div className="relative">
        {poster && (
          <img src={poster} alt="" aria-hidden className="absolute inset-0 w-full h-full object-cover blur-3xl opacity-30 scale-110 pointer-events-none" />
        )}
        <video
          ref={ref}
          controls
          crossOrigin="anonymous"
          poster={poster}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          className="relative w-full aspect-video max-h-[62vh] object-contain rounded-2xl bg-black ring-1 ring-white/10 shadow-2xl shadow-black/60"
        >
          {base && <track kind="captions" srcLang="en" label="English" src={base + 'transcript.vtt'} />}
        </video>
      </div>

      {!results ? (
        <Skeleton />
      ) : (
        <>
          {base && results.summary.chapters.length > 0 && (
            <ChapterStrip base={base} chapters={results.summary.chapters} time={time} duration={duration} onSeek={seek} />
          )}
          <div className="fade-in grid gap-4 md:grid-cols-[2fr_1fr]">
            <Card title="Summary">
              <p className="text-slate-200 leading-relaxed">{results.summary.summary || 'No speech found in this video.'}</p>
            </Card>
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
      setDetail((prev) => (prev && !r ? prev : d))
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
    return <div className="min-h-screen flex items-center justify-center bg-[#07090c] text-slate-400">Loading...</div>
  }

  const { video } = detail

  return (
    <div className="min-h-screen bg-[#07090c] overflow-x-clip">
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        <header className="space-y-3">
          <Link to="/" className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-sky-300 transition-colors">
            &larr; Dashboard
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-white">{video.title}</h1>
            <StatusBadge status={video.status} />
          </div>
          <p className="text-xs text-slate-500">Uploaded {new Date(video.created_at).toLocaleString()}</p>
        </header>

        {!detail.url ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-slate-400 text-sm">Upload still in progress...</div>
        ) : video.status === 'failed' ? (
          <div className="rounded-2xl border border-red-400/20 bg-red-400/5 p-6 text-red-300 text-sm">Processing failed.</div>
        ) : (
          <Watch detail={detail} results={results} />
        )}
      </div>
    </div>
  )
}
