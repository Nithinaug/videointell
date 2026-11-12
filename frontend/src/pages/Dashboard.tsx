import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listVideos, type Video } from '../api/client'
import Shell from '../components/Shell'
import VideoCard from '../components/VideoCard'

export default function Dashboard() {
  const [videos, setVideos] = useState<Video[] | null>(null)
  const [blocked, setBlocked] = useState<string | null>(null)

  useEffect(() => {
    let stopped = false
    async function refresh() {
      try {
        const v = await listVideos()
        if (!stopped) setVideos(v)
      } catch (err: unknown) {
        const msg = (err as { response?: { status?: number; data?: { error?: string } } })?.response
        if (!stopped && msg?.status === 403) setBlocked(msg.data?.error ?? 'You cannot use the app right now.')
      }
    }
    refresh()
    const interval = setInterval(refresh, 5000)
    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [])

  return (
    <Shell>
      <header className="mb-10 border-b border-border-subtle pb-6">
        <p className="mb-3 font-mono text-xs uppercase tracking-[0.08em] text-ink-muted">Library · <span className="tabular-nums text-ink-primary">{videos ? String(videos.length).padStart(2, '0') : '--'}</span></p>
        <h1 className="font-display title-xl text-ink-primary">Videos</h1>
      </header>

      {blocked ? (
        <div className="glass rounded-outer px-6 py-16 text-center">
          <p className="font-medium text-ink-primary">{blocked}</p>
          <p className="mt-2 text-sm text-ink-muted">This is a small public preview with a limited number of accounts. Please try again later.</p>
        </div>
      ) : videos === null ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="shimmer aspect-[4/3] rounded-outer" />
          ))}
        </div>
      ) : videos.length === 0 ? (
        <div className="glass rounded-outer px-6 py-20 text-center">
          <p className="text-ink-muted">No videos yet.</p>
          <Link to="/upload" className="btn-glow mt-5 inline-block rounded-outer px-5 py-2.5 text-sm font-semibold">
            Upload
          </Link>
        </div>
      ) : (
        <motion.div
          className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3"
          initial="hidden"
          animate="show"
          variants={{ show: { transition: { staggerChildren: 0.05 } } }}
        >
          {videos.map((v) => (
            <motion.div
              key={v.id}
              variants={{ hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } }}
            >
              <VideoCard video={v} onDeleted={() => setVideos((all) => all?.filter((x) => x.id !== v.id) ?? null)} />
            </motion.div>
          ))}
        </motion.div>
      )}
    </Shell>
  )
}
