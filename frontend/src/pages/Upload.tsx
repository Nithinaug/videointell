import { AnimatePresence, motion } from 'motion/react'
import { useRef, useState, type DragEvent, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { createVideo, uploadFile } from '../api/client'
import Shell from '../components/Shell'

function Ring({ value }: { value: number }) {
  const r = 26
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90" aria-hidden>
      <circle cx="32" cy="32" r={r} fill="none" stroke="var(--border-subtle)" strokeWidth="5" />
      <motion.circle
        cx="32"
        cy="32"
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray={c}
        animate={{ strokeDashoffset: c * (1 - value) }}
        transition={{ type: 'spring', stiffness: 80, damping: 20 }}
      />
      </svg>
  )
}

function size(bytes: number) {
  return bytes > 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)} GB` : `${(bytes / (1 << 20)).toFixed(1)} MB`
}

export default function Upload() {
  const navigate = useNavigate()
  const input = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function pick(f: File | undefined) {
    if (!f) return
    if (!f.type.startsWith('video/')) {
      setError('That file is not a video.')
      return
    }
    setError(null)
    setFile(f)
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''))
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragging(false)
    pick(e.dataTransfer.files[0])
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!file) return
    setError(null)
    setProgress(0)
    try {
      const contentType = file.type || 'video/mp4'
      const { video, upload_url } = await createVideo(title || file.name, file.name, contentType, file.size)
      await uploadFile(upload_url, file, contentType, setProgress)
      setDone(true)
      setTimeout(() => navigate(`/videos/${video.id}`), 700)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(msg ?? 'Upload failed')
      setProgress(null)
    }
  }

  const busy = progress !== null

  return (
    <Shell>
      <div className="mx-auto max-w-2xl">
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.08em] text-ink-muted">New upload</p>
        <h1 className="font-display title-xl text-ink-primary">Upload</h1>

        <form onSubmit={onSubmit} className="glass mt-6 space-y-5 rounded-outer p-6">
          <button
            type="button"
            disabled={busy}
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`relative grid w-full min-h-56 place-items-center overflow-hidden rounded-outer border-2 border-dashed p-6 text-center transition-colors ${
              dragging ? 'border-accent bg-accent/10' : 'border-border-subtle hover:border-border-strong hover:bg-subtle'
            }`}
          >
            <input ref={input} type="file" accept="video/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
            <AnimatePresence mode="wait">
              {done ? (
                <motion.div key="done" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 400, damping: 15 }} className="flex flex-col items-center gap-2">
                  <span className="grid h-16 w-16 place-items-center rounded-outer bg-accent/15 text-3xl text-accent ring-1 ring-accent/30">&#10003;</span>
                  <span className="font-medium text-accent">Uploaded</span>
                </motion.div>
              ) : busy ? (
                <motion.div key="busy" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-3">
                  {(progress ?? 0) < 1 ? (
                    <div className="relative">
                      <Ring value={progress ?? 0} />
                      <span className="absolute inset-0 grid place-items-center text-xs font-semibold text-ink-primary">{Math.round((progress ?? 0) * 100)}%</span>
                    </div>
                  ) : (
                    <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.1, ease: 'linear' }}>
                      <Ring value={0.25} />
                    </motion.div>
                  )}
                  <span className="text-sm text-ink-primary">{(progress ?? 0) < 1 ? `Uploading ${file?.name}` : 'Saving...'}</span>
                </motion.div>
              ) : file ? (
                <motion.div key="file" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center gap-1">
                  <span className="text-4xl" aria-hidden>&#127902;</span>
                  <span className="font-medium text-ink-primary break-all">{file.name}</span>
                  <span className="font-mono text-xs tabular-nums text-ink-muted">{size(file.size)}</span>
                </motion.div>
              ) : (
                <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-2">
                  <motion.span animate={dragging ? { y: -6, scale: 1.1 } : { y: 0, scale: 1 }} className="grid h-14 w-14 place-items-center rounded-outer bg-accent/20 text-2xl text-ink-primary ring-1 ring-border-subtle">
                    &#8593;
                  </motion.span>
                  <span className="font-medium text-ink-primary">{dragging ? 'Drop it' : 'Drag a video here'}</span>
                  <span className="text-xs text-ink-muted">or click to choose</span>
                </motion.div>
              )}
            </AnimatePresence>
          </button>

          <label className="block">
            <span className="font-mono text-xs font-medium uppercase tracking-[0.08em] text-ink-muted">Title</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Team meeting"
              maxLength={200}
              disabled={busy}
              className="mt-2 w-full rounded-outer border border-border-subtle bg-subtle px-4 py-3 text-ink-primary outline-none transition-colors placeholder:text-ink-muted focus:border-accent/60"
            />
          </label>

          {error && <p className="text-sm text-danger">{error}</p>}

          <button type="submit" disabled={!file || busy} className="btn-glow w-full rounded-outer py-3.5 font-semibold disabled:cursor-not-allowed disabled:opacity-50">
            {busy ? 'Uploading...' : 'Upload'}
          </button>
        </form>
      </div>
    </Shell>
  )
}
