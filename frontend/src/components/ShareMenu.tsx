import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { siGmail, siTelegram, siWhatsapp, siX, siYoutube } from 'simple-icons'
import { createShare } from '../api/client'
import { CheckIcon, ShareIcon } from './Icons'
import type { HdExport } from '../lib/useHdExport'

type Target = { name: string; path: string; color: string; href: (url: string, title: string) => string }

const linkedinPath =
  'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z'

const targets: Target[] = [
  { name: 'WhatsApp', path: siWhatsapp.path, color: `#${siWhatsapp.hex}`, href: (u, t) => `https://wa.me/?text=${encodeURIComponent(`${t} ${u}`)}` },
  { name: 'Gmail', path: siGmail.path, color: `#${siGmail.hex}`, href: (u, t) => `https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(t)}&body=${encodeURIComponent(u)}` },
  { name: 'X', path: siX.path, color: '#ffffff', href: (u, t) => `https://twitter.com/intent/tweet?text=${encodeURIComponent(t)}&url=${encodeURIComponent(u)}` },
  { name: 'LinkedIn', path: linkedinPath, color: '#0A66C2', href: (u) => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(u)}` },
  { name: 'Telegram', path: siTelegram.path, color: `#${siTelegram.hex}`, href: (u, t) => `https://t.me/share/url?url=${encodeURIComponent(u)}&text=${encodeURIComponent(t)}` },
]

function BrandIcon({ path, color }: { path: string; color: string }) {
  return (
    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/[0.06]">
      <svg viewBox="0 0 24 24" aria-hidden className="h-4 w-4" fill={color}>
        <path d={path} />
      </svg>
    </span>
  )
}

export default function ShareMenu({ videoId, title, hd, resultsUrl }: { videoId: string; title: string; hd: HdExport; resultsUrl?: string }) {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [copied, setCopied] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (!open || url) return
    let live = true
    setError(false)
    createShare(videoId, 7)
      .then(({ token }) => live && setUrl(`${location.origin}/share/${token}`))
      .catch(() => live && setError(true))
    return () => {
      live = false
    }
  }, [open, url, videoId])

  async function copy() {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setError(true)
    }
  }

  async function youtube() {
    const file = hd.downloadUrl(resultsUrl, title)
    if (file) {
      const a = document.createElement('a')
      a.href = file
      a.click()
      window.open('https://www.youtube.com/upload', '_blank', 'noopener,noreferrer')
      setOpen(false)
      return
    }
    if (hd.state === 'working') return
    const err = await hd.start()
    if (err) alert(err)
  }

  const youtubeLabel = hd.state === 'ready' ? 'YouTube: save HD file' : hd.state === 'working' ? 'YouTube: making HD' : 'YouTube: make HD first'

  function nativeShare() {
    if (!url) return
    navigator.share({ title, url }).catch(() => {})
  }

  const item = 'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm text-zinc-200 transition-colors hover:bg-white/5 disabled:opacity-40 disabled:hover:bg-transparent'

  return (
    <div ref={root} className="relative ml-auto">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Share"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Share"
        className="grid h-9 w-9 pointer-coarse:size-11 place-items-center rounded-full text-zinc-300 ring-1 ring-white/10 transition-colors hover:bg-white/5 hover:text-white"
      >
        <ShareIcon />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            aria-label="Share this video"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: -6 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: -6 }}
            transition={{ type: 'spring', stiffness: 520, damping: 34 }}
            style={{ transformOrigin: 'top right' }}
            className="absolute right-0 top-full z-30 mt-2 w-60 rounded-2xl bg-zinc-900/95 p-1.5 shadow-2xl ring-1 ring-white/10 backdrop-blur"
          >
            {error && <p className="px-2.5 py-2 text-xs text-red-300">Could not create the link. Close and try again.</p>}
            {!error && !url && <p role="status" className="px-2.5 py-2 text-xs text-zinc-400">Making a 7-day link</p>}
            {canNativeShare && (
              <button role="menuitem" disabled={!url} onClick={nativeShare} className={item}>
                <span className="grid h-7 w-7 place-items-center rounded-full bg-amber-400/20 text-amber-300">
                  <ShareIcon className="h-3.5 w-3.5" />
                </span>
                Share with an app
              </button>
            )}
            {targets.map((t, i) => (
              <motion.a
                key={t.name}
                role="menuitem"
                aria-disabled={!url}
                href={url ? t.href(url, title) : undefined}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => !url && e.preventDefault()}
                initial={reduce ? false : { opacity: 0, x: 6 }}
                animate={{ opacity: url ? 1 : 0.4, x: 0 }}
                transition={{ delay: reduce ? 0 : 0.03 * i }}
                className={item}
              >
                <BrandIcon path={t.path} color={t.color} />
                {t.name}
              </motion.a>
            ))}
            {hd.available && (
              <button role="menuitem" disabled={hd.state === 'working'} onClick={youtube} className={item}>
                <BrandIcon path={siYoutube.path} color={`#${siYoutube.hex}`} />
                {youtubeLabel}
              </button>
            )}
            <button role="menuitem" disabled={!url} onClick={copy} className={item}>
              <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10 text-zinc-300">
                {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <ShareIcon className="h-3.5 w-3.5" />}
              </span>
              {copied ? 'Link copied' : 'Copy link'}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
