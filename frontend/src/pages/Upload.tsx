import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { completeUpload, createVideo, uploadFile } from '../api/client'

export default function Upload() {
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!file) return
    setError(null)
    try {
      setProgress('Creating video record...')
      const contentType = file.type || 'video/mp4'
      const { video, upload_url } = await createVideo(title || file.name, file.name, contentType)

      setProgress('Uploading file...')
      await uploadFile(upload_url, file, contentType)

      setProgress('Finalizing...')
      await completeUpload(video.id)

      navigate(`/videos/${video.id}`)
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Upload failed')
      setProgress(null)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-[#0d1117]">
      <form onSubmit={onSubmit} className="w-full max-w-md flex flex-col gap-[22px] p-8 bg-[#131c27] border border-[#1e2d3d] rounded-2xl shadow-[0_12px_40px_#00000059]">
        <h1 className="text-xl font-semibold text-slate-100">Upload a video</h1>
        {error && <p className="text-xs text-red-400 text-center">{error}</p>}
        <div className="flex flex-col gap-[9px]">
          <label className="text-[11px] font-bold tracking-[0.09em] text-slate-400">TITLE</label>
          <div className="flex items-center px-3.5 bg-[#0d1117] border border-[#1e2d3d] rounded-[10px] transition-colors focus-within:border-slate-100">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Project Meeting.mp4"
              className="flex-1 min-w-0 bg-transparent border-none text-slate-100 text-sm py-3.5 outline-none placeholder:text-slate-500"
            />
          </div>
        </div>
        <div className="flex flex-col gap-[9px]">
          <label className="text-[11px] font-bold tracking-[0.09em] text-slate-400">VIDEO FILE</label>
          <input
            type="file"
            accept="video/*"
            required
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="w-full text-slate-300 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={!!progress}
          className="w-full mt-1 py-3.5 rounded-xl bg-slate-50 text-[#0d1117] text-[15px] font-semibold cursor-pointer transition-colors hover:not-disabled:bg-slate-200 disabled:opacity-60 disabled:cursor-default"
        >
          {progress ?? 'Upload'}
        </button>
      </form>
    </div>
  )
}
