import { useEffect, useRef, useState } from 'react'
import { animate, motion, useReducedMotion } from 'motion/react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import Hls from 'hls.js'
import { canDelete, deleteVideo, getProgress, renameVideo, getResults, getVideoDetail, progressPercent, type Clip, type Segment, type Results, type VideoDetail as VideoDetailT } from '../api/client'
import AskCard from '../components/AskCard'
import ClipControls from '../components/ClipControls'
import ClipsPanel from '../components/ClipsPanel'
import { DownloadIcon, PencilIcon, TrashIcon } from '../components/Icons'
import Shell from '../components/Shell'
import ShareMenu from '../components/ShareMenu'
import ExportHd from '../components/ExportHd'
import { useHdExport } from '../lib/useHdExport'
import { loadClip } from '../lib/clip'
import { downloadTxt, downloadVtt } from '../lib/download'
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
    <nav aria-label="Chapters" className="fade-in scrollbar-none flex gap-3 overflow-x-auto snap-x pb-2 -mx-4 px-4">
      {chapters.map((c, i) => {
        const end = starts[i + 1] ?? duration
        const progress = i < active ? 1 : i === active && end > starts[i] ? (time - starts[i]) / (end - starts[i]) : 0
        return (
          <button
            key={c.start + c.title}
            ref={i === active ? activeRef : undefined}
            aria-current={i === active}
            onClick={() => onSeek(starts[i])}
            className={`group snap-start shrink-0 w-44 text-left rounded-outer overflow-hidden ring-1 transition duration-200 ${
              i === active ? 'ring-2 ring-accent bg-subtle' : 'ring-border-subtle bg-subtle hover:ring-border-strong'
            }`}
          >
            <div className="relative aspect-video bg-scrim">
              <img
                src={thumbFor(base, starts[i])}
                alt=""
                loading="lazy"
                crossOrigin="anonymous"
                onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
                className={`w-full h-full object-cover transition-opacity group-hover:opacity-100 ${i === active ? 'opacity-100' : 'opacity-80'}`}
              />
              <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-scrim/70 font-mono text-[10px] text-on-scrim">
                {c.start}
              </span>
              <div className="absolute inset-x-0 bottom-0 h-0.5 bg-subtle">
                <div className="h-full w-full origin-left bg-accent transition-transform duration-300" style={{ transform: `scaleX(${progress})` }} />
              </div>
            </div>
            <p className={`px-3 py-2 text-sm truncate ${i === active ? 'text-ink-primary' : 'text-ink-muted'}`}>{c.title}</p>
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
          <div className="shimmer aspect-video rounded-outer" />
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
        <p className="mb-2 text-xs text-ink-muted">
          {shown.length + onScreen.length} {shown.length + onScreen.length === 1 ? 'match' : 'matches'} for &ldquo;{filter.trim()}&rdquo;
        </p>
      )}
      {onScreen.length > 0 && (
        <div className="-mx-2 mb-2 border-b border-border-subtle pb-2">
          {onScreen.map((s) => (
            <button
              key={'screen' + s.from_ms}
              onClick={() => onSeek(s.from_ms / 1000)}
              className="flex w-full gap-3 rounded-outer px-2 py-1.5 pointer-coarse:py-3 text-left text-sm text-ink-primary transition-colors hover:bg-subtle"
            >
              <span className="w-12 shrink-0 pt-0.5 font-mono text-xs text-ink-muted">{clock(s.from_ms / 1000)}</span>
              <span className="min-w-0">
                <span className="mr-2 rounded bg-subtle px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ink-primary">On screen</span>
                <span>{snippet(s.text, terms)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {filtering && shown.length === 0 && onScreen.length === 0 && (
        <p className="text-sm text-ink-muted">
          Nobody says or shows that in this video.{' '}
          <Link to={`/search?q=${encodeURIComponent(filter.trim())}`} className="text-accent hover:text-accent">
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
            className={`flex w-full gap-3 rounded-inner px-2 py-1.5 pointer-coarse:py-3 text-left text-sm leading-relaxed transition-colors duration-200 ${
              i === active ? 'bg-subtle text-ink-primary' : 'text-ink-muted hover:bg-subtle hover:text-ink-primary'
            }`}
          >
            <span className={`w-10 shrink-0 pt-0.5 font-mono text-xs ${i === active ? 'text-accent' : 'text-ink-muted'}`}>{clock(s.from_ms / 1000)}</span>
            <span>{s.text}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function Watch({ detail, results, startAt, filter, asked, onRename }: { detail: VideoDetailT; results: Results | null; startAt: number; filter: string; asked: string; onRename: (title: string) => void }) {
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
      getVideoDetail(detail.video.id)
        .then((d) => loadClip(d.results_url ?? base, clip.start_ms / 1000, clip.end_ms / 1000))
        .then((c) => {
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
      const onMeta = () => {
        resume()
        if (!clip) return
        video.currentTime = clip.start_ms / 1000
        stopAt.current = clip.end_ms / 1000
        video.play().catch(() => {})
      }
      video.src = src
      video.addEventListener('loadedmetadata', onMeta, { once: true })
      return () => video.removeEventListener('loadedmetadata', onMeta)
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

  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {})
  keyHandler.current = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (e.ctrlKey || e.metaKey || e.altKey || (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable))) return
      const video = ref.current
      if (!video) return
      const k = e.key.toLowerCase()
      if (k === 'f') {
        e.preventDefault()
        if (e.repeat) return
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
        else (clipView ? box.current : video)?.requestFullscreen().catch(() => {})
      } else if (k === ' ' || k === 'k') {
        if (el?.tagName === 'BUTTON' && k === ' ') return
        e.preventDefault()
        if (clipView) clipToggle()
        else if (video.paused) video.play().catch(() => {})
        else video.pause()
      } else if (k === 'arrowleft' || k === 'arrowright') {
        if (el?.closest('[role=tab],[role=slider]')) return
        e.preventDefault()
        const step = k === 'arrowleft' ? -5 : 5
        if (clipView) clipSeek(Math.min(Math.max(0, rel + step), clipView.length))
        else video.currentTime = Math.min(Math.max(0, video.currentTime + step), video.duration || Infinity)
      } else if (k === 'm') {
        video.muted = !video.muted
      }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const searching = filter.trim().length >= 2

  useEffect(() => {
    if (searching) setTab('transcript')
  }, [searching, asked])

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-4">
      <motion.div ref={box} layoutId={`media-${detail.video.id}`} className="group relative">
        {!base ? (
          <div role="status" className="relative grid w-full aspect-video place-items-center rounded-outer bg-canvas ring-1 ring-border-subtle">
            <div className="flex flex-col items-center gap-3">
              <motion.span
                aria-hidden
                className="h-10 w-10 rounded-full border-2 border-border-subtle border-t-accent"
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 0.9, ease: 'linear' }}
              />
              <span className="text-sm text-ink-muted">
                Processing...{percent !== null && <CountUp value={percent} />}
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
          className="relative w-full aspect-video object-contain rounded-outer bg-canvas ring-1 ring-border-subtle"
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

      <aside className="glass flex max-h-[75vh] min-h-[24rem] flex-col overflow-hidden rounded-outer lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)]">
        <div role="tablist" aria-label="Video details" className="flex shrink-0 gap-1 border-b border-border-subtle p-1.5">
          {(['transcript', 'clips', 'summary'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`flex-1 rounded-inner px-3 py-1.5 pointer-coarse:py-3 text-sm capitalize transition-colors ${tab === t ? 'bg-subtle font-medium text-ink-primary' : 'text-ink-muted hover:text-ink-primary'}`}
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
              <div className="mb-3 flex items-center justify-end gap-2 text-xs">
                <span className="flex items-center gap-1.5 text-ink-muted">
                  <DownloadIcon className="h-3.5 w-3.5" />
                  Download
                </span>
                <div role="group" aria-label="Download transcript" className="flex rounded-outer bg-subtle p-0.5">
                  <button onClick={() => downloadVtt(base!, detail.video.title).catch(() => alert('Could not download the subtitles. Try again.'))} title="Subtitles file for video players" className="rounded-inner px-3 py-1 pointer-coarse:py-3 font-medium text-ink-primary transition-colors hover:bg-subtle hover:text-ink-primary">
                    Subtitles <span className="text-ink-muted">.vtt</span>
                  </button>
                  <button onClick={() => downloadTxt(results.transcript, detail.video.title)} title="Plain text transcript" className="rounded-inner px-3 py-1 pointer-coarse:py-3 font-medium text-ink-primary transition-colors hover:bg-subtle hover:text-ink-primary">
                    Text <span className="text-ink-muted">.txt</span>
                  </button>
                </div>
              </div>
              {asked.length >= 2 ? (
                <AskCard q={asked} videoId={detail.video.id} onSeek={seek} />
              ) : (
                searching && <p className="mb-3 text-xs text-ink-muted">Press Enter to get an AI answer from this video.</p>
              )}
              <Transcript segments={results.transcript} screen={results.screen} time={time} onSeek={seek} filter={filter} />
            </>
          ) : tab === 'clips' ? (
            <ClipsPanel videoId={detail.video.id} time={time} duration={duration} activeId={clip?.id} onPlay={playClip} />
          ) : (
            <div className="space-y-4">
              {results.summary.title && results.summary.title !== detail.video.title && (
                <div className="flex items-center gap-2 rounded-outer bg-subtle px-3 py-2 text-sm ring-1 ring-border-subtle">
                  <span className="min-w-0 flex-1 truncate text-ink-primary">
                    <span className="mr-2 text-xs text-ink-muted">Suggested title</span>
                    {results.summary.title}
                  </span>
                  <button onClick={() => onRename(results.summary.title!)} className="shrink-0 rounded-inner px-2 py-1 text-xs text-accent ring-1 ring-border-subtle hover:bg-subtle">
                    Use it
                  </button>
                </div>
              )}
              <p className="text-sm leading-relaxed text-ink-primary">{results.summary.summary || 'No speech found in this video.'}</p>
              {results.summary.takeaways && results.summary.takeaways.length > 0 && (
                <div>
                  <h3 className="mb-1 font-mono text-xs font-medium uppercase tracking-[0.08em] text-ink-muted">Key points</h3>
                  <ul className="space-y-1">
                    {results.summary.takeaways.filter((k) => typeof k.at === 'string' && Number.isFinite(toSeconds(k.at))).map((k) => (
                      <li key={k.at + k.text}>
                        <button onClick={() => seek(toSeconds(k.at))} className="flex w-full gap-3 rounded-inner px-2 py-1.5 pointer-coarse:py-3 text-left text-sm text-ink-primary hover:bg-subtle">
                          <span className="w-10 shrink-0 pt-0.5 tabular-nums text-xs text-accent">{clock(toSeconds(k.at))}</span>
                          <span>{k.text}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}

function CountUp({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const from = useRef(value)
  const reduce = useReducedMotion()
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (reduce) {
      el.textContent = `${value}%`
      from.current = value
      return
    }
    const controls = animate(from.current, value, {
      duration: 0.6,
      ease: 'easeOut',
      onUpdate: (v) => {
        el.textContent = `${Math.round(v)}%`
      },
    })
    from.current = value
    return () => controls.stop()
  }, [value, reduce])
  return <span ref={ref} className="ml-1.5 tabular-nums text-ink-primary">{value}%</span>
}

export default function VideoDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const startAt = Number(params.get('t')) || 0
  const [deleting, setDeleting] = useState(false)
  const [editing, setEditing] = useState(false)
  const [detail, setDetail] = useState<VideoDetailT | null>(null)
  const [results, setResults] = useState<Results | null>(null)
  const hd = useHdExport(id ?? '', !!id && detail?.video.status === 'ready')
  const { pending: hdPending, state: hdState, clearPending: clearHdPending, downloadUrl: hdUrl } = hd
  const resultsUrl = detail?.results_url
  const videoTitle = detail?.video.title ?? ''

  useEffect(() => {
    if (!hdPending) return
    if (hdState === 'failed') {
      clearHdPending()
      alert('The HD export failed. Try again.')
      return
    }
    if (hdState !== 'ready') return
    const url = hdUrl(resultsUrl, videoTitle)
    clearHdPending()
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.click()
  }, [hdPending, hdState, clearHdPending, hdUrl, resultsUrl, videoTitle])

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
        <div className="shimmer aspect-video rounded-outer" />
      </Shell>
    )
  }

  const { video } = detail

  async function onRename(title: string) {
    const t = title.trim()
    setEditing(false)
    if (!t || t === video.title) return
    try {
      const updated = await renameVideo(video.id, t)
      setDetail((prev) => (prev ? { ...prev, video: { ...prev.video, title: updated.title } } : prev))
    } catch {
      alert('Could not rename the video. Try again.')
    }
  }

  async function onDelete() {
    if (!confirm(`Delete "${video.title}"? This removes the video, its clips and its results for good.`)) return
    setDeleting(true)
    deleteVideo(video.id).catch(() => alert(`Could not delete "${video.title}". It will show up again; try once more.`))
    navigate('/', { replace: true })
  }

  return (
    <Shell>
      <div className="space-y-5">
        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            {editing ? (
              <input
                autoFocus
                defaultValue={video.title}
                maxLength={200}
                aria-label="Video title"
                onBlur={(e) => onRename(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') {
                    e.currentTarget.value = video.title
                    setEditing(false)
                  }
                }}
                className="min-w-0 flex-1 rounded-outer border border-border-subtle bg-subtle px-3 py-1.5 font-display text-2xl font-semibold text-ink-primary outline-none focus:border-accent/60 md:text-3xl"
              />
            ) : (
              <>
                <h1 className="font-display title-xl text-ink-primary">{video.title}</h1>
                {video.status === 'ready' && (
                  <button onClick={() => setEditing(true)} aria-label="Rename video" title="Rename video" className="grid h-8 w-8 pointer-coarse:size-11 place-items-center rounded-outer text-ink-muted transition-colors hover:bg-subtle hover:text-ink-primary">
                    <PencilIcon className="h-3.5 w-3.5" />
                  </button>
                )}
              </>
            )}
            <div className="ml-auto flex items-center gap-2">
            {video.status === 'ready' && (
              <>
                <ExportHd hd={hd} resultsUrl={detail.results_url} title={video.title} />
                <ShareMenu videoId={video.id} title={video.title} hd={hd} resultsUrl={detail.results_url} />
              </>
            )}
            {canDelete(video.status) && (
              <button
                onClick={onDelete}
                disabled={deleting}
                aria-label="Delete video"
                title="Delete video"
                className={`grid h-9 w-9 pointer-coarse:size-11 place-items-center rounded-outer text-ink-primary ring-1 ring-border-subtle transition-colors hover:bg-danger/15 hover:text-danger hover:ring-danger/40 disabled:opacity-50`}
              >
                <TrashIcon />
              </button>
            )}
            </div>
          </div>
          <p className="font-mono text-xs tabular-nums text-ink-muted">{new Date(video.created_at).toLocaleString()}</p>
        </header>

        {!detail.url ? (
          <div className="glass rounded-outer p-6 text-sm text-ink-muted">Upload still in progress...</div>
        ) : video.status === 'failed' ? (
          <div className="glass rounded-outer border-danger/30 p-6 text-sm text-danger">Processing failed.</div>
        ) : (
          <Watch detail={detail} results={results} startAt={startAt} filter={params.get('q') ?? ''} asked={params.get('ask') === '1' ? (params.get('q') ?? '').trim() : ''} onRename={onRename} />
        )}
      </div>
    </Shell>
  )
}
