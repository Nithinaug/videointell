import axios from 'axios'
import { startLogin } from '../auth'
import { clearSession } from '../context/AuthContext'

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080'

export const api = axios.create({ baseURL: API_BASE_URL })

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

api.interceptors.response.use(undefined, (error) => {
  if (error.response?.status === 401) {
    clearSession()
    startLogin()
  }
  return Promise.reject(error)
})

export interface Video {
  id: string
  user_id: string
  title: string
  content_type: string
  status: 'uploading' | 'uploaded' | 'processing' | 'ready' | 'failed'
  created_at: string
  updated_at: string
  results_url?: string
}

export interface Progress {
  status: Video['status']
  split: boolean
  chunks: number
  chunks_done: number
  assembled: boolean
  summary: boolean
}

export async function getProgress(videoId: string) {
  const { data } = await api.get<Progress>(`/api/videos/${videoId}/progress`)
  return data
}

export function progressPercent(p: Progress) {
  if (p.status === 'ready' || p.summary) return 100
  if (p.assembled) return 95
  if (p.split && p.chunks > 0) return Math.round(10 + (75 * Math.min(p.chunks_done, p.chunks)) / p.chunks)
  return p.status === 'processing' ? 5 : 0
}

export interface VideoDetail {
  video: Video
  url?: string
  results_url?: string
}

export interface Summary {
  summary: string
  chapters: { start: string; title: string }[]
  tags: string[]
}

export interface Segment {
  from_ms: number
  to_ms: number
  text: string
}

export interface Results {
  summary: Summary
  transcript: Segment[]
  screen: Segment[]
}

export interface SearchHit {
  video_id: string
  title: string
  from_ms: number
  text: string
  kind: 'speech' | 'screen'
  results_url?: string
}

const deleting = new Set<string>()

export async function listVideos() {
  const { data } = await api.get<{ videos: Video[] }>('/api/videos')
  return data.videos.filter((v) => !deleting.has(v.id)).map((v) => (v.results_url ? { ...v, results_url: API_BASE_URL + v.results_url } : v))
}

export async function createVideo(title: string, filename: string, contentType: string, size: number) {
  const { data } = await api.post<{ video: Video; upload_url: string }>('/api/videos', {
    title,
    filename,
    content_type: contentType,
    size,
  })
  return data
}

export async function uploadFile(uploadUrl: string, file: File, contentType: string, onProgress?: (fraction: number) => void) {
  await axios.put(API_BASE_URL + uploadUrl, file, {
    headers: { 'Content-Type': contentType },
    onUploadProgress: (e) => onProgress?.(e.total ? e.loaded / e.total : 0),
  })
}

export interface SearchResult {
  results: SearchHit[]
  searched: number
  skipped: string[]
}

export interface Clip {
  id: string
  video_id: string
  title: string
  start_ms: number
  end_ms: number
  created_at: string
}

export async function listClips(videoId: string) {
  const { data } = await api.get<{ clips: Clip[] }>(`/api/videos/${videoId}/clips`)
  return data.clips
}

export async function createClip(videoId: string, title: string, startMS: number, endMS: number) {
  const { data } = await api.post<Clip>(`/api/videos/${videoId}/clips`, { title, start_ms: startMS, end_ms: endMS })
  return data
}

export async function deleteClip(videoId: string, clipId: string) {
  await api.delete(`/api/videos/${videoId}/clips/${clipId}`)
}

export async function createShare(videoId: string, days: number) {
  const { data } = await api.post<{ token: string }>(`/api/videos/${videoId}/shares`, { days })
  return data
}

export interface ShareView {
  title: string
  base: string
  base_expires_at: number
  clips: Clip[]
}

export async function shareView(token: string): Promise<ShareView | null> {
  const res = await fetch(API_BASE_URL + '/api/share-view', { headers: { 'X-Share-Token': token }, referrerPolicy: 'no-referrer' })
  if (!res.ok) return null
  const data = (await res.json()) as ShareView
  return { ...data, base: API_BASE_URL + data.base }
}

export interface AskResult {
  answer: string
  sources: SearchHit[]
  truncated: boolean
  scope: 'video' | 'all'
}

export async function ask(q: string, videoId?: string): Promise<AskResult> {
  const { data } = await api.post<AskResult>('/api/ask', { q, video_id: videoId ?? '' })
  return data
}

export async function search(q: string, videoId?: string): Promise<SearchResult> {
  const { data } = await api.get<SearchResult>('/api/search', { params: videoId ? { q, video_id: videoId } : { q } })
  return { ...data, results: data.results.map((h) => (h.results_url ? { ...h, results_url: API_BASE_URL + h.results_url } : h)) }
}

export async function deleteVideo(videoId: string) {
  deleting.add(videoId)
  try {
    await api.delete(`/api/videos/${videoId}`)
  } finally {
    deleting.delete(videoId)
  }
}

export function canDelete(status: Video['status']) {
  return status !== 'uploaded' && status !== 'processing'
}

export async function getVideoDetail(videoId: string) {
  const { data } = await api.get<VideoDetail>(`/api/videos/${videoId}`)
  if (data.url) data.url = API_BASE_URL + data.url
  if (data.results_url) data.results_url = API_BASE_URL + data.results_url
  return data
}

export async function getResults(resultsUrl: string): Promise<Results | null> {
  try {
    const summary = await axios.get<Summary>(resultsUrl + 'summary.json')
    const transcript = await axios
      .get<{ segments?: Segment[] }>(resultsUrl + 'transcript.json')
      .then((r) => r.data.segments ?? [])
      .catch(() => [])
    const screen = await axios
      .get<{ frames?: Segment[] }>(resultsUrl + 'screen.json')
      .then((r) => r.data.frames ?? [])
      .catch(() => [])
    return { summary: summary.data, transcript, screen }
  } catch {
    return null
  }
}
