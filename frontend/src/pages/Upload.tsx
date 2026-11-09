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
      <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="5" />
      <motion.circle
        cx="32"
        cy="32"
        r={r}
        fill="none"
        stroke="url(#ring)"
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray={c}
        animate={{ strokeDashoffset: c * (1 - value) }}
        transition={{ type: 'spring', stiffness: 80, damping: 20 }}
      />
      <defs>
        <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
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
      const { video, upload_url } = await createVideo(title || file.name, file.name, contentType)
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
        <h1 className="font-display text-3xl font-bold tracking-tight text-white">Upload</h1>

        <form onSubmit={onSubmit} className="glass mt-6 space-y-5 rounded-3xl p-6">
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
            className={`relative grid w-full min-h-56 place-items-center overflow-hidden rounded-2xl border-2 border-dashed p-6 text-center transition-colors ${
              dragging ? 'border-sky-400 bg-sky-400/10' : 'border-white/15 hover:border-white/30 hover:bg-white/[0.03]'
            }`}
          >
            <input ref={input} type="file" accept="video/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
            <AnimatePresence mode="wait">
              {done ? (
                <motion.div key="done" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 400, damping: 15 }} className="flex flex-col items-center gap-2">
                  <span className="grid h-16 w-16 place-items-center rounded-full bg-emerald-400/15 text-3xl text-emerald-300 ring-1 ring-emerald-400/30">&#10003;</span>
                  <span className="font-medium text-emerald-200">Uploaded</span>
                </motion.div>
              ) : busy ? (
                <motion.div key="busy" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-3">
                  <div className="relative">
                    <Ring value={progress ?? 0} />
                    <span className="absolute inset-0 grid place-items-center text-xs font-semibold text-white">{Math.round((progress ?? 0) * 100)}%</span>
                  </div>
                  <span className="text-sm text-slate-300">Uploading {file?.name}</span>
                </motion.div>
              ) : file ? (
                <motion.div key="file" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center gap-1">
                  <span className="text-4xl" aria-hidden>&#127902;</span>
                  <span className="font-medium text-white break-all">{file.name}</span>
                  <span className="text-xs text-slate-400">{size(file.size)}</span>
                </motion.div>
              ) : (
                <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-2">
                  <motion.span animate={dragging ? { y: -6, scale: 1.1 } : { y: 0, scale: 1 }} className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-violet-500/30 to-sky-400/30 text-2xl text-white ring-1 ring-white/15">
                    &#8593;
                  </motion.span>
                  <span className="font-medium text-white">{dragging ? 'Drop it' : 'Drag a video here'}</span>
                  <span className="text-xs text-slate-400">or click to choose</span>
                </motion.div>
              )}
            </AnimatePresence>
          </button>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-400">Title</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Team meeting"
              disabled={busy}
              className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-white outline-none transition-colors placeholder:text-slate-500 focus:border-sky-400/60"
            />
          </label>

          {error && <p className="text-sm text-red-300">{error}</p>}

          <button type="submit" disabled={!file || busy} className="btn-glow w-full rounded-xl py-3.5 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
            {busy ? 'Uploading...' : 'Upload'}
          </button>
        </form>
      </div>
    </Shell>
  )
}
