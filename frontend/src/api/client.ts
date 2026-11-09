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
  labels: boolean
  summary: boolean
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
  labels: string[]
  transcript: Segment[]
}

export interface SearchHit {
  video_id: string
  title: string
  from_ms: number
  text: string
  results_url?: string
}

export async function listVideos() {
  const { data } = await api.get<{ videos: Video[] }>('/api/videos')
  return data.videos.map((v) => (v.results_url ? { ...v, results_url: API_BASE_URL + v.results_url } : v))
}

export async function createVideo(title: string, filename: string, contentType: string) {
  const { data } = await api.post<{ video: Video; upload_url: string }>('/api/videos', {
    title,
    filename,
    content_type: contentType,
  })
  return data
}

export async function uploadFile(uploadUrl: string, file: File, contentType: string, onProgress?: (fraction: number) => void) {
  await axios.put(API_BASE_URL + uploadUrl, file, {
    headers: { 'Content-Type': contentType },
    onUploadProgress: (e) => onProgress?.(e.total ? e.loaded / e.total : 0),
  })
}

export async function search(q: string) {
  const { data } = await api.get<{ results: SearchHit[] }>('/api/search', { params: { q } })
  return data.results.map((h) => (h.results_url ? { ...h, results_url: API_BASE_URL + h.results_url } : h))
}

export async function deleteVideo(videoId: string) {
  await api.delete(`/api/videos/${videoId}`)
}

export function canDelete(status: Video['status']) {
  return status !== 'uploaded' && status !== 'processing'
}

export async function getProgress(videoId: string) {
  const { data } = await api.get<Progress>(`/api/videos/${videoId}/progress`)
  return data
}

export async function getVideoDetail(videoId: string) {
  const { data } = await api.get<VideoDetail>(`/api/videos/${videoId}`)
  if (data.url) data.url = API_BASE_URL + data.url
  if (data.results_url) data.results_url = API_BASE_URL + data.results_url
  return data
}

export async function getResults(resultsUrl: string): Promise<Results | null> {
  try {
    const [summary, labels] = await Promise.all([
      axios.get<Summary>(resultsUrl + 'summary.json'),
      axios.get<string[]>(resultsUrl + 'labels.json'),
    ])
    const transcript = await axios
      .get<{ segments?: Segment[] }>(resultsUrl + 'transcript.json')
      .then((r) => r.data.segments ?? [])
      .catch(() => [])
    return { summary: summary.data, labels: labels.data, transcript }
  } catch {
    return null
  }
}
