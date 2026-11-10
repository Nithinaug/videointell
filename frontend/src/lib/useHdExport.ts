import { useCallback, useEffect, useState } from 'react'
import axios from 'axios'
import { getExport, startExport, type ExportState } from '../api/client'

export interface HdExport {
  state: ExportState
  available: boolean
  pending: boolean
  clearPending: () => void
  start: () => Promise<string | null>
  downloadUrl: (resultsUrl: string | undefined, title: string) => string | null
}

export function useHdExport(videoId: string, enabled: boolean): HdExport {
  const [state, setState] = useState<ExportState>('none')
  const [available, setAvailable] = useState(false)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!enabled) return
    getExport(videoId)
      .then((d) => {
        setState(d.state)
        setAvailable(d.available)
      })
      .catch(() => setAvailable(true))
  }, [videoId, enabled])

  useEffect(() => {
    if (state !== 'working') return
    const timer = setInterval(() => {
      getExport(videoId)
        .then((d) => setState(d.state))
        .catch(() => {})
    }, 5000)
    return () => clearInterval(timer)
  }, [state, videoId])

  const start = useCallback(async () => {
    try {
      const d = await startExport(videoId)
      setState(d.state)
      setPending(true)
      return null
    } catch (e) {
      return (axios.isAxiosError(e) && e.response?.data?.error) || 'Could not start the HD export. Try again.'
    }
  }, [videoId])

  const downloadUrl = useCallback(
    (resultsUrl: string | undefined, title: string) => (state === 'ready' && resultsUrl ? `${resultsUrl}hd.mp4?dl=1&name=${encodeURIComponent(title)}` : null),
    [state],
  )

  const clearPending = useCallback(() => setPending(false), [])

  return { state, available, pending, clearPending, start, downloadUrl }
}
