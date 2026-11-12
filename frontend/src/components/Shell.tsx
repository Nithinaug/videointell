import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation, useMatch, useNavigate, useSearchParams } from 'react-router-dom'
import { search, type SearchHit } from '../api/client'
import { useAuth } from '../context/AuthContext'
import { HomeIcon, SignOutIcon, UploadIcon } from './Icons'
import { snippet } from '../lib/snippet'
import { clock } from '../lib/time'

export default function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const videoMatch = useMatch('/videos/:id')
  const onVideo = videoMatch !== null
  const videoId = videoMatch?.params.id
  const [suggestions, setSuggestions] = useState<SearchHit[] | null>(null)
  const [open, setOpen] = useState(false)
  const onSearchPage = pathname === '/search'
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState(params.get('q') ?? '')
  const typed = useRef(false)
  const searchBox = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))) return
      e.preventDefault()
      searchBox.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  function go(text: string, push: boolean, asking = false) {
    const t = text.trim()
    const ask = asking && t.length >= 2
    if (onVideo) {
      setParams((p) => {
        const n = new URLSearchParams(p)
        if (t) n.set('q', t)
        else n.delete('q')
        if (ask) n.set('ask', '1')
        else n.delete('ask')
        return n
      }, { replace: true })
    } else if (!t && onSearchPage) {
      navigate('/', { replace: true })
    } else if (t) {
      navigate(`/search?q=${encodeURIComponent(t)}${ask ? '&ask=1' : ''}`, { replace: onSearchPage && !push })
    }
  }

  useEffect(() => {
    if (!typed.current || (!onVideo && !onSearchPage)) return
    timer.current = setTimeout(() => go(q, false), 300)
    return () => clearTimeout(timer.current)
  }, [q])

  function onSearch(e: FormEvent) {
    e.preventDefault()
    clearTimeout(timer.current)
    setOpen(false)
    go(q, false, true)
  }

  const where = onVideo ? 'this video' : 'all your videos'
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 640px)').matches)

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const update = () => setNarrow(mq.matches)
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
  const showDrop = open && !onSearchPage && suggestions !== null && q.trim().length >= 2

  useEffect(() => {
    if (!typed.current || onSearchPage || q.trim().replace(/\s+/g, '').length < 2) {
      setSuggestions(null)
      return
    }
    let stopped = false
    const id = setTimeout(() => {
      search(q.trim(), videoId)
        .then((r) => {
          if (stopped) return
          setSuggestions(r.results.slice(0, 6))
          setOpen(true)
        })
        .catch(() => !stopped && setSuggestions(null))
    }, 250)
    return () => {
      stopped = true
      clearTimeout(id)
    }
  }, [q])

  function pick(s: SearchHit) {
    setOpen(false)
    if (videoId === s.video_id) window.dispatchEvent(new CustomEvent('videointell:seek', { detail: s.from_ms / 1000 }))
    else navigate(`/videos/${s.video_id}?t=${Math.floor(s.from_ms / 1000)}`)
  }

  return (
    <div className="relative min-h-screen overflow-x-clip bg-canvas text-ink-primary">
      <header className="relative z-20 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(1rem,env(safe-area-inset-top))]">
        <nav className="glass-bar mx-auto grid max-w-6xl grid-cols-[auto_1fr_auto] items-center gap-3 rounded-outer px-4 py-2.5 md:grid-cols-[1fr_minmax(0,28rem)_1fr]">
          <Link to="/" aria-label="Home" title="Home" className="grid h-9 w-9 pointer-coarse:size-11 place-items-center justify-self-start rounded-outer text-ink-muted ring-1 ring-border-subtle transition-colors hover:bg-subtle hover:text-ink-primary">
            <HomeIcon />
          </Link>
          <form onSubmit={onSearch} role="search" className="relative min-w-0">
            <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              ref={searchBox}
              type="search"
              value={q}
              autoFocus={onSearchPage}
              onFocus={(e) => {
                e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)
                if (suggestions) setOpen(true)
              }}
              onChange={(e) => {
                typed.current = true
                setQ(e.target.value)
              }}
              onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
              onBlur={() => setTimeout(() => setOpen(false), 150)}
              placeholder={narrow ? 'Search' : onVideo ? 'Search in this video' : 'Search in all videos'}
              aria-label={`Search what is said or shown in ${where}`}
              aria-expanded={showDrop}
              aria-controls="search-suggestions"
              className={`w-full rounded-outer border border-border-subtle bg-subtle py-2 pointer-coarse:py-3 pl-9 text-sm text-ink-primary outline-none transition-colors placeholder:text-ink-muted focus:border-accent/60 pr-3.5`}
            />
            {showDrop && (
              <div id="search-suggestions" className="absolute inset-x-0 top-full z-30 mt-2 overflow-hidden rounded-outer border border-border-subtle bg-surface shadow-surface backdrop-blur">
                {suggestions.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-ink-muted">No matches in {where}.</p>
                ) : (
                  <ul>
                    {suggestions.map((s) => (
                      <li key={s.kind + s.video_id + s.from_ms}>
                        <button
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => pick(s)}
                          className="flex w-full gap-3 px-4 py-2 text-left text-sm transition-colors hover:bg-subtle focus:bg-subtle focus:outline-none"
                        >
                          <span className="w-10 shrink-0 pt-0.5 font-mono text-xs text-accent">{clock(s.from_ms / 1000)}</span>
                          <span className="min-w-0">
                            {s.kind === 'screen' && <span className="mr-2 rounded bg-subtle px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ink-primary">On screen</span>}
                            {!onVideo && <span className="mr-2 text-xs text-ink-muted">{s.title}</span>}
                            <span className="text-ink-primary">{snippet(s.text, terms, 90)}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="border-t border-border-subtle px-4 py-2 text-xs text-ink-muted">Press Enter for all results</p>
              </div>
            )}
          </form>
          <div className="flex shrink-0 items-center justify-end gap-2">
            <Link to="/upload" aria-label="Upload" title="Upload" className="btn-glow grid h-9 w-9 pointer-coarse:size-11 place-items-center rounded-outer">
              <UploadIcon />
            </Link>
            <button
              onClick={logout}
              aria-label="Sign out"
              title={user?.email ? `Sign out (${user.email})` : 'Sign out'}
              className="grid h-9 w-9 pointer-coarse:size-11 place-items-center rounded-outer text-ink-primary ring-1 ring-border-subtle transition-colors hover:bg-subtle hover:text-ink-primary"
            >
              <SignOutIcon />
            </button>
          </div>
        </nav>
      </header>
      <main className="relative z-10 mx-auto max-w-6xl px-4 py-12 md:py-16">{children}</main>
    </div>
  )
}
