import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

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
  const [params] = useSearchParams()
  const [q, setQ] = useState(params.get('q') ?? '')

  function onSearch(e: FormEvent) {
    e.preventDefault()
    if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`)
  }

  return (
    <div className="relative min-h-screen overflow-x-clip bg-[#0c0c0e] text-zinc-200">
      <Aurora />
      <header className="sticky top-0 z-20 px-4 pt-4">
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
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find a moment: type words someone said"
              aria-label="Search the spoken words in all your videos"
              title="Searches the transcripts of all your videos and jumps to the moment"
              className="w-full rounded-xl border border-white/10 bg-black/30 py-2 pl-9 pr-3.5 text-sm text-white outline-none transition-colors placeholder:text-slate-500 focus:border-amber-400/60"
            />
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
