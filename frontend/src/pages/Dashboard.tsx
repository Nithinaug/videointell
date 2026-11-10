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
      <h1 className="font-display mb-6 text-3xl font-bold tracking-tight text-white">Videos</h1>

      {blocked ? (
        <div className="glass rounded-3xl px-6 py-16 text-center">
          <p className="font-medium text-white">{blocked}</p>
          <p className="mt-2 text-sm text-zinc-400">This is a small public preview with a limited number of accounts. Please try again later.</p>
        </div>
      ) : videos === null ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="shimmer aspect-[4/3] rounded-3xl" />
          ))}
        </div>
      ) : videos.length === 0 ? (
        <div className="glass rounded-3xl px-6 py-20 text-center">
          <p className="text-slate-400">No videos yet.</p>
          <Link to="/upload" className="btn-glow mt-5 inline-block rounded-xl px-5 py-2.5 text-sm font-semibold text-white">
            Upload
          </Link>
        </div>
      ) : (
        <motion.div
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 [grid-auto-flow:dense]"
          initial="hidden"
          animate="show"
          variants={{ show: { transition: { staggerChildren: 0.05 } } }}
        >
          {videos.map((v, i) => (
            <motion.div
              key={v.id}
              className={i === 0 ? 'sm:col-span-2 sm:row-span-2' : ''}
              variants={{ hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } }}
            >
              <VideoCard video={v} big={i === 0} onDeleted={() => setVideos((all) => all?.filter((x) => x.id !== v.id) ?? null)} />
            </motion.div>
          ))}
        </motion.div>
      )}
    </Shell>
  )
}
