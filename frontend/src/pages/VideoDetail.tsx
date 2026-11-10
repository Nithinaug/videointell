import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import Hls from 'hls.js'
import { canDelete, createShare, deleteVideo, getProgress, getResults, getVideoDetail, progressPercent, type Clip, type Segment, type Results, type VideoDetail as VideoDetailT } from '../api/client'
import AskCard from '../components/AskCard'
import ClipControls from '../components/ClipControls'
import ClipsPanel from '../components/ClipsPanel'
import { ShareIcon, TrashIcon } from '../components/Icons'
import Shell from '../components/Shell'
import { loadClip } from '../lib/clip'
import { firstAppearances, snippet } from '../lib/snippet'
import { clock, thumbFor, toSeconds } from '../lib/time'

const POLL_MS = 10_000

export function ChapterStrip({
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
              i === active ? 'ring-white/40 bg-white/[0.06]' : 'ring-white/10 bg-white/[0.02] hover:ring-white/25'
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
                <div className="h-full bg-amber-400 transition-[width] duration-300" style={{ width: `${progress * 100}%` }} />
              </div>
            </div>
            <p className={`px-3 py-2 text-sm truncate ${i === active ? 'text-white' : 'text-zinc-400'}`}>{c.title}</p>
          </button>
        )
      })}
    </nav>
  )
}

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Processing video" className="flex gap-3 overflow-hidden">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="shrink-0 w-44 space-y-2">
          <div className="shimmer aspect-video rounded-xl" />
          <div className="shimmer h-3 w-3/4 rounded" />
        </div>
      ))}
    </div>
  )
}

export function Transcript({ segments, screen, time, onSeek, filter }: { segments: Segment[]; screen: Segment[]; time: number; onSeek: (s: number) => void; filter: string }) {
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

  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean)
  const filtering = terms.join('').length >= 2
  const matches = (text: string) => terms.every((t) => text.toLowerCase().includes(t))
  const shown = segments.map((s, i) => ({ s, i })).filter(({ s }) => !filtering || matches(s.text))
  const onScreen = filtering ? firstAppearances(screen, matches) : []

  if (segments.length === 0 && onScreen.length === 0) return null
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {filtering && (
        <p className="mb-2 text-xs text-zinc-500">
          {shown.length + onScreen.length} {shown.length + onScreen.length === 1 ? 'match' : 'matches'} for &ldquo;{filter.trim()}&rdquo;
        </p>
      )}
      {onScreen.length > 0 && (
        <div className="-mx-2 mb-2 border-b border-white/5 pb-2">
          {onScreen.map((s) => (
            <button
              key={'screen' + s.from_ms}
              onClick={() => onSeek(s.from_ms / 1000)}
              className="flex w-full gap-3 rounded-xl px-2 py-1.5 text-left text-sm text-slate-300 transition-colors hover:bg-white/5"
            >
              <span className="w-12 shrink-0 pt-0.5 font-mono text-xs text-slate-500">{clock(s.from_ms / 1000)}</span>
              <span className="min-w-0">
                <span className="mr-2 rounded bg-sky-400/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-200">On screen</span>
                <span>{snippet(s.text, terms)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {filtering && shown.length === 0 && onScreen.length === 0 && (
        <p className="text-sm text-zinc-400">
          Nobody says or shows that in this video.{' '}
          <Link to={`/search?q=${encodeURIComponent(filter.trim())}`} className="text-amber-400 hover:text-amber-300">
            Search all videos instead
          </Link>
        </p>
      )}
      <div ref={box} className="relative -mx-2 min-h-0 flex-1 overflow-y-auto pr-1">
        {shown.map(({ s, i }) => (
          <button
            key={s.from_ms + s.text}
            ref={i === active ? activeRef : undefined}
            aria-current={i === active}
            onClick={() => onSeek(s.from_ms / 1000)}
            className={`flex w-full gap-3 rounded-lg px-2 py-1.5 text-left text-sm leading-relaxed transition-colors duration-200 ${
              i === active ? 'bg-white/[0.07] text-white' : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200'
            }`}
          >
            <span className={`w-10 shrink-0 pt-0.5 font-mono text-xs ${i === active ? 'text-amber-300' : 'text-zinc-600'}`}>{clock(s.from_ms / 1000)}</span>
            <span>{s.text}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function Watch({ detail, results, startAt, filter, asked }: { detail: VideoDetailT; results: Results | null; startAt: number; filter: string; asked: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  const started = useRef(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const base = results ? detail.results_url : undefined
  const poster = base ? base + 'thumbs/thumb_01.jpg' : undefined

  const stopAt = useRef<number | null>(null)
  const [clip, setClip] = useState<Clip | null>(null)
  const resumeAt = useRef<number | null>(null)
  const clipBase = useRef(0)
  const [clipView, setClipView] = useState<{ offset: number; length: number } | null>(null)
  const [playing, setPlaying] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const rel = clip && clipView ? Math.min(Math.max(0, time - clip.start_ms / 1000), clipView.length) : 0

  function clipSeek(v: number) {
    const video = ref.current
    if (!video || !clipView) return
    video.currentTime = clipView.offset + v
    stopAt.current = clipView.offset + clipView.length
  }

  function clipToggle() {
    const video = ref.current
    if (!video || !clipView) return
    if (!video.paused) return video.pause()
    if (rel >= clipView.length - 0.1) clipSeek(0)
    stopAt.current = clipView.offset + clipView.length
    video.play().catch(() => {})
  }

  useEffect(() => {
    const video = ref.current
    if (!video) return
    if (!base) {
      video.src = detail.url ?? ''
      return
    }
    clipBase.current = 0
    setClipView(null)
    const native = video.canPlayType('application/vnd.apple.mpegurl') || !Hls.isSupported()
    if (clip && !native) {
      let hls: Hls | null = null
      let url = ''
      let stopped = false
      loadClip(base, clip.start_ms / 1000, clip.end_ms / 1000).then((c) => {
        if (stopped || !c) return
        url = c.url
        clipBase.current = clip.start_ms / 1000 - c.offset
        hls = new Hls()
        hls.loadSource(c.url)
        hls.attachMedia(video)
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.currentTime = c.offset
          stopAt.current = c.offset + c.length
          setClipView({ offset: c.offset, length: c.length })
          video.play().catch(() => {})
        })
      })
      return () => {
        stopped = true
        hls?.destroy()
        if (url) URL.revokeObjectURL(url)
      }
    }
    const src = base + 'hls/master.m3u8'
    const resume = () => {
      if (resumeAt.current === null) return
      video.currentTime = resumeAt.current
      resumeAt.current = null
    }
    if (native) {
      video.src = src
      video.addEventListener('loadedmetadata', resume, { once: true })
      if (clip) {
        video.currentTime = clip.start_ms / 1000
        stopAt.current = clip.end_ms / 1000
        video.play().catch(() => {})
      }
      return
    }
    const hls = new Hls()
    hls.loadSource(src)
    hls.attachMedia(video)
    hls.on(Hls.Events.MANIFEST_PARSED, resume)
    return () => hls.destroy()
  }, [base, detail.url, clip])

  function seek(seconds: number) {
    const video = ref.current
    if (!video) return
    stopAt.current = null
    if (clip) {
      resumeAt.current = seconds
      setClip(null)
      return
    }
    video.currentTime = seconds
    video.play()
  }

  function playClip(c: Clip) {
    if (clip?.id === c.id) {
      fullVideo()
      return
    }
    setClip(c)
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ref.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' })
  }

  function fullVideo() {
    resumeAt.current = clip ? clip.start_ms / 1000 : null
    stopAt.current = null
    setClip(null)
  }

  useEffect(() => {
    function onSeek(e: Event) {
      seek((e as CustomEvent<number>).detail)
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ref.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' })
    }
    window.addEventListener('videointell:seek', onSeek)
    return () => window.removeEventListener('videointell:seek', onSeek)
  }, [])

  const [percent, setPercent] = useState<number | null>(null)

  useEffect(() => {
    if (base) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const p = await getProgress(detail.video.id)
        if (!stopped) setPercent((prev) => Math.max(prev ?? 0, progressPercent(p)))
      } catch {
        /* keep the last value */
      }
      if (!stopped) timer = setTimeout(poll, 2000)
    }
    poll()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [base, detail.video.id])

  const [tab, setTab] = useState<'transcript' | 'clips' | 'summary'>('transcript')
  const searching = filter.trim().length >= 2

  useEffect(() => {
    if (searching) setTab('transcript')
  }, [searching, asked])

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-4">
      <motion.div ref={box} layoutId={`media-${detail.video.id}`} className="group relative">
        {!base ? (
          <div role="status" className="relative grid w-full aspect-video place-items-center rounded-2xl bg-black ring-1 ring-white/10">
            <div className="flex flex-col items-center gap-3">
              <motion.span
                aria-hidden
                className="h-10 w-10 rounded-full border-2 border-white/10 border-t-amber-400"
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 0.9, ease: 'linear' }}
              />
              <span className="text-sm text-zinc-400">
                Processing...{percent !== null && <span className="ml-1.5 tabular-nums text-zinc-200">{percent}%</span>}
              </span>
            </div>
          </div>
        ) : (
        <video
          ref={ref}
          controls={!clipView}
          crossOrigin="anonymous"
          poster={poster}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onClick={() => clipView && clipToggle()}
          onTimeUpdate={(e) => {
            const t = e.currentTarget.currentTime
            setTime(t + clipBase.current)
            if (stopAt.current !== null && t >= stopAt.current) {
              stopAt.current = null
              e.currentTarget.pause()
            }
          }}
          onLoadedMetadata={(e) => {
            if (!clip) setDuration(e.currentTarget.duration)
            if (startAt > 0 && base && !started.current) {
              started.current = true
              e.currentTarget.currentTime = startAt
              e.currentTarget.play().catch(() => {})
            }
          }}
          className="relative w-full aspect-video object-contain rounded-2xl bg-black ring-1 ring-white/10"
        >
          <track kind="captions" srcLang="en" label="English" src={base + 'transcript.vtt'} />
        </video>
        )}
        {clip && clipView && <ClipControls playing={playing} position={rel} length={clipView.length} onToggle={clipToggle} onSeek={clipSeek} fullscreenTarget={box} />}
      </motion.div>
        {!results ? (
          <Skeleton />
        ) : (
          base && results.summary.chapters.length > 0 && <ChapterStrip base={base} chapters={results.summary.chapters} time={time} duration={duration} onSeek={seek} />
        )}
      </div>

      <aside className="glass flex max-h-[75vh] min-h-[24rem] flex-col overflow-hidden rounded-2xl lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)]">
        <div role="tablist" aria-label="Video details" className="flex shrink-0 gap-1 border-b border-white/5 p-1.5">
          {(['transcript', 'clips', 'summary'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`flex-1 rounded-lg px-3 py-1.5 text-sm capitalize transition-colors ${tab === t ? 'bg-white/[0.08] font-medium text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              {t}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={`flex min-h-0 flex-1 flex-col p-4 ${tab === 'transcript' && results ? 'overflow-hidden' : 'overflow-y-auto'}`}>
          {!results ? (
            <div aria-busy="true" className="space-y-3">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="shimmer h-4 rounded" style={{ width: `${90 - i * 8}%` }} />
              ))}
            </div>
          ) : tab === 'transcript' ? (
            <>
              {asked.length >= 2 ? (
                <AskCard q={asked} videoId={detail.video.id} onSeek={seek} />
              ) : (
                searching && <p className="mb-3 text-xs text-zinc-500">Press Enter to get an AI answer from this video.</p>
              )}
              <Transcript segments={results.transcript} screen={results.screen} time={time} onSeek={seek} filter={filter} />
            </>
          ) : tab === 'clips' ? (
            <ClipsPanel videoId={detail.video.id} time={time} duration={duration} activeId={clip?.id} onPlay={playClip} />
          ) : (
            <p className="text-sm leading-relaxed text-zinc-300">{results.summary.summary || 'No speech found in this video.'}</p>
          )}
        </div>
      </aside>
    </div>
  )
}

export default function VideoDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const startAt = Number(params.get('t')) || 0
  const [deleting, setDeleting] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
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
    if (!confirm(`Delete "${video.title}"? This removes the video, its clips and its results for good.`)) return
    setDeleting(true)
    deleteVideo(video.id).catch(() => alert(`Could not delete "${video.title}". It will show up again; try once more.`))
    navigate('/', { replace: true })
  }

  async function onShare() {
    setSharing(true)
    try {
      const { token } = await createShare(video.id, 7)
      await navigator.clipboard.writeText(`${location.origin}/share/${token}`)
      setToast('Link copied to clipboard')
    } catch {
      setToast('Could not create the link')
    } finally {
      setSharing(false)
      setTimeout(() => setToast(null), 2500)
    }
  }

  return (
    <Shell>
      <div className="space-y-5">
        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-2xl md:text-3xl font-semibold tracking-tight text-white">{video.title}</h1>
            {video.status === 'ready' && (
              <div className="relative ml-auto">
                <button
                  onClick={onShare}
                  disabled={sharing}
                  aria-label="Share"
                  title="Share"
                  className="grid h-9 w-9 place-items-center rounded-xl text-slate-300 ring-1 ring-white/10 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-50"
                >
                  <ShareIcon />
                </button>
                <AnimatePresence>
                  {toast && (
                    <motion.p
                      role="status"
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      className="absolute right-0 top-full z-20 mt-2 whitespace-nowrap rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-white shadow-xl ring-1 ring-white/10"
                    >
                      {toast}
                    </motion.p>
                  )}
                </AnimatePresence>
              </div>
            )}
            {canDelete(video.status) && (
              <button
                onClick={onDelete}
                disabled={deleting}
                aria-label="Delete video"
                title="Delete video"
                className={`${video.status === 'ready' ? '' : 'ml-auto '}grid h-9 w-9 place-items-center rounded-xl text-slate-300 ring-1 ring-white/10 transition-colors hover:bg-red-500/15 hover:text-red-200 hover:ring-red-400/40 disabled:opacity-50`}
              >
                <TrashIcon />
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
          <Watch detail={detail} results={results} startAt={startAt} filter={params.get('q') ?? ''} asked={params.get('ask') === '1' ? (params.get('q') ?? '').trim() : ''} />
        )}
      </div>
    </Shell>
  )
}
