import Hls, { type LoaderCallbacks, type LoaderConfiguration, type LoaderContext } from 'hls.js'
import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { shareView, type Clip, type Segment, type ShareView, type Summary } from '../api/client'
import ClipControls from '../components/ClipControls'
import { loadClip } from '../lib/clip'
import { clock } from '../lib/time'
import { ChapterStrip, Transcript } from './VideoDetail'

const REFRESH_MS = 4 * 60 * 1000
const SIGNED = /^.*?\/api\/share-files\/\d+\/[^/]+\//

function signedPart(base: string) {
  return base.slice(0, base.indexOf('/processed/') + 1)
}

export default function SharePage() {
  const { token = '' } = useParams<{ token: string }>()
  const [view, setView] = useState<ShareView | null>(null)
  const [gone, setGone] = useState(false)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [segments, setSegments] = useState<Segment[]>([])
  const [screen, setScreen] = useState<Segment[]>([])
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [tab, setTab] = useState<'transcript' | 'clips' | 'summary'>('transcript')
  const ref = useRef<HTMLVideoElement>(null)
  const current = useRef('')
  const stopAt = useRef<number | null>(null)
  const firstBase = useRef<string | null>(null)
  const latest = useRef<string | null>(null)
  const [params] = useSearchParams()
  const [active, setActive] = useState<Clip | null>(null)
  const [clipView, setClipView] = useState<{ offset: number; length: number } | null>(null)
  const [playing, setPlaying] = useState(false)
  const clipBase = useRef(0)
  const resumeAt = useRef<number | null>(null)
  const picked = useRef(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    async function load() {
      const v = await shareView(token).catch(() => null)
      if (stopped) return
      if (!v) {
        setGone(true)
        ref.current?.pause()
        return
      }
      current.current = signedPart(v.base)
      setView(v)
      timer = setTimeout(load, REFRESH_MS)
    }
    load()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [token])

  const base = view?.base

  useEffect(() => {
    if (!base || firstBase.current) return
    firstBase.current = base
    fetch(base + 'summary.json').then((r) => (r.ok ? r.json() : null)).then(setSummary).catch(() => {})
    fetch(base + 'transcript.json').then((r) => (r.ok ? r.json() : null)).then((t) => setSegments(t?.segments ?? [])).catch(() => {})
    fetch(base + 'screen.json').then((r) => (r.ok ? r.json() : null)).then((t) => setScreen(t?.frames ?? [])).catch(() => {})
  }, [base])

  useEffect(() => {
    const video = ref.current
    if (!video || !base) return
    latest.current = base
    const native = video.canPlayType('application/vnd.apple.mpegurl') || !Hls.isSupported()
    if (native) {
      const at = video.currentTime
      const playing = !video.paused
      video.src = base + 'hls/master.m3u8'
      video.addEventListener(
        'loadedmetadata',
        () => {
          video.currentTime = at
          if (playing) video.play().catch(() => {})
        },
        { once: true },
      )
    }
  }, [base])

  const ready = !!base
  const wanted = params.get('clip')

  useEffect(() => {
    if (view && wanted && !picked.current) {
      picked.current = true
      const c = view.clips.find((x) => x.id === wanted)
      if (c) {
        setActive(c)
        setTab('clips')
      }
    }
  }, [view, wanted])

  useEffect(() => {
    const video = ref.current
    const b = latest.current
    if (!video || !b || video.canPlayType('application/vnd.apple.mpegurl') || !Hls.isSupported()) {
      if (video && active) {
        video.currentTime = active.start_ms / 1000
        stopAt.current = active.end_ms / 1000
      }
      return
    }
    class ShareLoader extends Hls.DefaultConfig.loader {
      load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>) {
        context.url = context.url.replace(SIGNED, current.current)
        super.load(context, config, callbacks)
      }
    }
    clipBase.current = 0
    setClipView(null)
    let hls: Hls | null = null
    let blob = ''
    let stopped = false
    if (active) {
      loadClip(b, active.start_ms / 1000, active.end_ms / 1000).then((c) => {
        if (stopped || !c) return
        blob = c.url
        clipBase.current = active.start_ms / 1000 - c.offset
        hls = new Hls({ loader: ShareLoader })
        hls.loadSource(c.url)
        hls.attachMedia(video)
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.currentTime = c.offset
          stopAt.current = c.offset + c.length
          setClipView({ offset: c.offset, length: c.length })
          video.play().catch(() => {})
        })
      })
    } else {
      hls = new Hls({ loader: ShareLoader })
      hls.loadSource(b + 'hls/master.m3u8')
      hls.attachMedia(video)
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (resumeAt.current === null) return
        video.currentTime = resumeAt.current
        resumeAt.current = null
      })
    }
    return () => {
      stopped = true
      hls?.destroy()
      if (blob) URL.revokeObjectURL(blob)
    }
  }, [ready, active])

  const rel = active && clipView ? Math.min(Math.max(0, time - active.start_ms / 1000), clipView.length) : 0

  function seek(seconds: number) {
    const video = ref.current
    if (!video) return
    stopAt.current = null
    if (active) {
      resumeAt.current = seconds
      setActive(null)
      return
    }
    video.currentTime = seconds
    video.play().catch(() => {})
  }

  function playClip(c: Clip) {
    if (active?.id === c.id) {
      resumeAt.current = c.start_ms / 1000
      setActive(null)
      return
    }
    setActive(c)
  }

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

  if (gone) {
    return (
      <div className="relative grid min-h-screen place-items-center bg-canvas px-4 text-center text-ink-primary">
        <div className="relative">
          <h1 className="font-display text-2xl font-semibold text-ink-primary">Link not available</h1>
          <p className="mt-2 text-sm text-ink-muted">This link has expired, been cancelled, or the video was removed.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="relative min-h-screen overflow-x-clip bg-canvas text-ink-primary">
      <main className="relative z-10 mx-auto max-w-6xl space-y-5 px-4 py-8">
        <header>
          <p className="font-mono text-xs uppercase tracking-[0.08em] text-ink-muted">Shared video</p>
          <h1 className="font-display title-xl mt-1 text-ink-primary">{view?.title ?? ' '}</h1>
        </header>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="min-w-0 space-y-4">
            {base ? (
              <div ref={box} className="relative">
              <video
                ref={ref}
                controls={!clipView}
                crossOrigin="anonymous"
                poster={base + 'thumbs/thumb_01.jpg'}
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
                onLoadedMetadata={(e) => !active && setDuration(e.currentTarget.duration)}
                className="w-full aspect-video rounded-outer bg-canvas object-contain ring-1 ring-border-subtle"
              >
                <track kind="captions" srcLang="en" label="English" src={base + 'transcript.vtt'} />
              </video>
              {active && clipView && <ClipControls playing={playing} position={rel} length={clipView.length} onToggle={clipToggle} onSeek={clipSeek} fullscreenTarget={box} />}
              </div>
            ) : (
              <div className="shimmer aspect-video rounded-outer" />
            )}
            {base && summary && summary.chapters.length > 0 && <ChapterStrip base={base} chapters={summary.chapters} time={time} duration={duration} onSeek={seek} />}
          </div>

          <aside className="glass flex max-h-[75vh] min-h-[24rem] flex-col overflow-hidden rounded-outer lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)]">
            <div role="tablist" aria-label="Video details" className="flex shrink-0 gap-1 border-b border-border-subtle p-1.5">
              {(['transcript', 'clips', 'summary'] as const).map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={`flex-1 rounded-inner px-3 py-1.5 text-sm capitalize transition-colors ${tab === t ? 'bg-subtle font-medium text-ink-primary' : 'text-ink-muted hover:text-ink-primary'}`}
                >
                  {t}
                </button>
              ))}
            </div>
            <div role="tabpanel" className={`flex min-h-0 flex-1 flex-col p-4 ${tab === 'transcript' ? 'overflow-hidden' : 'overflow-y-auto'}`}>
              {tab === 'transcript' ? (
                <Transcript segments={segments} screen={screen} time={time} onSeek={seek} filter="" />
              ) : tab === 'clips' ? (
                view && view.clips.length > 0 ? (
                  <ul className="space-y-1">
                    {view.clips.map((c) => (
                      <li key={c.id}>
                        <button
                          onClick={() => playClip(c)}
                          aria-pressed={active?.id === c.id}
                          className={`flex w-full items-center gap-3 rounded-inner px-2 py-1.5 text-left text-sm ring-1 transition-colors ${active?.id === c.id ? 'bg-accent/15 ring-accent/40' : 'ring-transparent hover:bg-subtle'}`}
                        >
                          <span className="shrink-0 tabular-nums text-xs text-accent">
                            {clock(c.start_ms / 1000)}-{clock(c.end_ms / 1000)}
                          </span>
                          <span className="truncate text-ink-primary">{c.title}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-ink-muted">No clips.</p>
                )
              ) : (
                <p className="text-sm leading-relaxed text-ink-primary">{summary?.summary || 'No summary.'}</p>
              )}
            </div>
          </aside>
        </div>
      </main>
    </div>
  )
}
