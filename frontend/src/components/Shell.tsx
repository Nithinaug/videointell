import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation, useMatch, useNavigate, useSearchParams } from 'react-router-dom'
import { search, type SearchHit } from '../api/client'
import { useAuth } from '../context/AuthContext'
import { snippet } from '../lib/snippet'
import { clock } from '../lib/time'

export function Aurora() {
  return (
    <>
      <div className="aurora" aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <div className="grain" aria-hidden />
    </>
  )
}

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
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
  const showDrop = open && !onSearchPage && suggestions !== null && q.trim().length >= 2

  useEffect(() => {
    if (!typed.current || onSearchPage || q.trim().replace(/\s+/g, '').length < 2) {
      setSuggestions(null)
      return
    }
    let stopped = false
    const id = setTimeout(() => {
      search(q.trim())
        .then((r) => {
          if (stopped) return
          setSuggestions(r.results.filter((h) => !videoId || h.video_id === videoId).slice(0, 6))
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
    <div className="relative min-h-screen overflow-x-clip bg-[#0c0c0e] text-zinc-200">
      <Aurora />
      <header className="relative z-20 px-4 pt-4">
        <nav className="glass mx-auto max-w-6xl flex items-center justify-between gap-3 rounded-2xl px-4 py-2.5">
          <Link to="/" aria-label="Home" className="flex items-center">
            <span className="grid place-items-center h-8 w-8 rounded-xl bg-gradient-to-br from-amber-500 to-amber-400 shadow-[0_0_24px_-4px_rgba(217,119,6,0.7)]">
              <svg viewBox="0 0 24 24" className="h-4 w-4 fill-white" aria-hidden>
                <path d="M8 5.5v13l10-6.5z" />
              </svg>
            </span>
          </Link>
          <form onSubmit={onSearch} role="search" className="relative min-w-0 flex-1 max-w-md">
            <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
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
              placeholder={onVideo ? 'Search this video' : 'Search all videos'}
              aria-label={`Search what is said or shown in ${where}`}
              aria-expanded={showDrop}
              aria-controls="search-suggestions"
              className={`w-full rounded-xl border border-white/10 bg-black/30 py-2 pl-9 text-sm text-white outline-none transition-colors placeholder:text-slate-500 focus:border-amber-400/60 pr-3.5`}
            />
            {showDrop && (
              <div id="search-suggestions" className="absolute inset-x-0 top-full z-30 mt-2 overflow-hidden rounded-2xl border border-white/10 bg-[#141416]/95 shadow-2xl backdrop-blur">
                {suggestions.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-zinc-400">No matches in {where}.</p>
                ) : (
                  <ul>
                    {suggestions.map((s) => (
                      <li key={s.kind + s.video_id + s.from_ms}>
                        <button
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => pick(s)}
                          className="flex w-full gap-3 px-4 py-2 text-left text-sm transition-colors hover:bg-white/5 focus:bg-white/5 focus:outline-none"
                        >
                          <span className="w-10 shrink-0 pt-0.5 font-mono text-xs text-amber-300">{clock(s.from_ms / 1000)}</span>
                          <span className="min-w-0">
                            {s.kind === 'screen' && <span className="mr-2 rounded bg-sky-400/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-200">On screen</span>}
                            {!onVideo && <span className="mr-2 text-xs text-zinc-500">{s.title}</span>}
                            <span className="text-zinc-200">{snippet(s.text, terms, 90)}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="border-t border-white/5 px-4 py-2 text-xs text-zinc-500">Press Enter for all results</p>
              </div>
            )}
          </form>
          <div className="flex shrink-0 items-center gap-2">
            <Link to="/upload" className="btn-glow rounded-xl px-3.5 py-2 text-sm font-semibold text-white">
              Upload
            </Link>
            <button
              onClick={logout}
              title={user?.email}
              className="rounded-xl px-3 py-2 text-sm text-slate-300 ring-1 ring-white/10 transition-colors hover:bg-white/5 hover:text-white"
            >
              Sign out
            </button>
          </div>
        </nav>
      </header>
      <main className="relative z-10 mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  )
}
