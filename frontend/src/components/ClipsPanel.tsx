import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState, type FormEvent } from 'react'
import { createClip, createShare, deleteClip, listClips, type Clip } from '../api/client'
import { CheckIcon, ShareIcon, TrashIcon } from './Icons'
import { clock } from '../lib/time'

const MAX_SECONDS = 300

export default function ClipsPanel({ videoId, time, duration, activeId, onPlay }: { videoId: string; time: number; duration: number; activeId?: string; onPlay: (clip: Clip) => void }) {
  const [clips, setClips] = useState<Clip[]>([])
  const [start, setStart] = useState<number | null>(null)
  const [end, setEnd] = useState<number | null>(null)
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  async function onShare(clip: Clip) {
    try {
      const { token } = await createShare(videoId, 7)
      await navigator.clipboard.writeText(`${location.origin}/share/${token}?clip=${clip.id}`)
      setCopied(clip.id)
      setTimeout(() => setCopied((c) => (c === clip.id ? null : c)), 2500)
    } catch {
      setError('Could not create the link.')
    }
  }

  useEffect(() => {
    listClips(videoId).then(setClips).catch(() => setError('Could not load clips.'))
  }, [videoId])

  const length = start !== null && end !== null ? end - start : 0
  const problem =
    start === null || end === null ? null : length < 1 ? 'The end must be at least 1 second after the start.' : length > MAX_SECONDS ? 'A clip can be at most 5 minutes long.' : null

  async function onSave(e: FormEvent) {
    e.preventDefault()
    if (start === null || end === null || problem) return
    setSaving(true)
    setError(null)
    try {
      const clip = await createClip(videoId, title.trim() || `Clip at ${clock(start)}`, Math.round(start * 1000), Math.round(end * 1000))
      setClips((all) => [...all, clip].sort((a, b) => a.start_ms - b.start_ms))
      setStart(null)
      setEnd(null)
      setTitle('')
    } catch (err: unknown) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not save the clip.')
    } finally {
      setSaving(false)
    }
  }

  async function onDelete(clip: Clip) {
    if (clip.id === activeId) onPlay(clip)
    setClips((all) => all.filter((c) => c.id !== clip.id))
    try {
      await deleteClip(videoId, clip.id)
    } catch {
      setClips((all) => [...all, clip].sort((a, b) => a.start_ms - b.start_ms))
      setError('Could not delete the clip.')
    }
  }

  const btn = 'whitespace-nowrap rounded-xl px-2.5 py-1.5 text-sm ring-1 ring-white/10 transition-colors hover:bg-white/5'

  return (
    <section aria-label="Clips">
      <form onSubmit={onSave} className="space-y-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={100}
          placeholder="Clip title (optional)"
          aria-label="Clip title"
          className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-1.5 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-amber-400/60"
        />
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => setStart(time)} className={btn}>
            Start {start !== null && <span className="ml-1 tabular-nums text-amber-300">{clock(start)}</span>}
          </button>
          <button type="button" onClick={() => setEnd(Math.min(time, duration || time))} className={btn}>
            End {end !== null && <span className="ml-1 tabular-nums text-amber-300">{clock(end)}</span>}
          </button>
          {(start !== null || end !== null || title) && (
            <button
              type="button"
              onClick={() => {
                setStart(null)
                setEnd(null)
                setTitle('')
                setError(null)
              }}
              className="whitespace-nowrap rounded-xl px-1.5 py-1.5 text-sm text-zinc-400 transition-colors hover:text-white"
            >
              Clear
            </button>
          )}
          <button type="submit" disabled={start === null || end === null || !!problem || saving} className={`btn-glow whitespace-nowrap rounded-xl px-3 py-1.5 text-sm font-semibold disabled:opacity-40 ml-auto`}>
            {saving ? 'Saving...' : 'Save clip'}
          </button>
        </div>
      </form>
      <p className="mt-2 text-xs text-zinc-500">{problem ?? error ?? 'Play to the start, press Start, play to the end, press End. Up to 5 minutes.'}</p>

      {clips.length > 0 && (
        <ul className="mt-4 space-y-1">
          <AnimatePresence initial={false}>
            {clips.map((c) => (
              <motion.li
                key={c.id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, height: 0 }}
                className={`flex items-center gap-3 rounded-xl px-2 py-1.5 ring-1 transition-colors ${c.id === activeId ? 'bg-amber-400/15 ring-amber-400/40' : 'ring-transparent hover:bg-white/5'}`}
              >
                <button
                  onClick={() => onPlay(c)}
                  aria-pressed={c.id === activeId}
                  title={c.id === activeId ? 'Click again to go back to the full video' : 'Play this clip'}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left text-sm"
                >
                  <span className="shrink-0 font-mono text-xs text-amber-300">
                    {clock(c.start_ms / 1000)}-{clock(c.end_ms / 1000)}
                  </span>
                  <span className="truncate text-zinc-200">{c.title}</span>
                </button>
                <button
                  onClick={() => onShare(c)}
                  aria-label={copied === c.id ? 'Link copied' : `Share clip ${c.title}`}
                  title={copied === c.id ? 'Link copied to clipboard' : 'Share clip'}
                  className={`grid h-7 w-7 shrink-0 pointer-coarse:size-11 place-items-center rounded-full transition-colors hover:bg-white/5 ${copied === c.id ? 'text-amber-300' : 'text-zinc-500 hover:text-white'}`}
                >
                  {copied === c.id ? <CheckIcon className="h-3.5 w-3.5" /> : <ShareIcon className="h-3.5 w-3.5" />}
                </button>
                <button
                  onClick={() => onDelete(c)}
                  aria-label={`Delete clip ${c.title}`}
                  title="Delete clip"
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-zinc-500 transition-colors hover:bg-red-500/15 hover:text-red-200"
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </section>
  )
}
