import axios from 'axios'

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080'

export const api = axios.create({ baseURL: API_BASE_URL })

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

export interface User {
  id: string
  email: string
  created_at: string
}

export interface Video {
  id: string
  user_id: string
  title: string
  content_type: string
  status: 'uploading' | 'uploaded'
  created_at: string
  updated_at: string
}

export interface VideoDetail {
  video: Video
  url?: string
}

export async function register(email: string, password: string) {
  const { data } = await api.post<{ token: string; user: User }>('/api/auth/register', { email, password })
  return data
}

export async function login(email: string, password: string) {
  const { data } = await api.post<{ token: string; user: User }>('/api/auth/login', { email, password })
  return data
}

export async function listVideos() {
  const { data } = await api.get<{ videos: Video[] }>('/api/videos')
  return data.videos
}

export async function createVideo(title: string, filename: string, contentType: string) {
  const { data } = await api.post<{ video: Video; upload_url: string }>('/api/videos', {
    title,
    filename,
    content_type: contentType,
  })
  return data
}

export async function uploadFile(uploadUrl: string, file: File, contentType: string) {
  await axios.put(API_BASE_URL + uploadUrl, file, { headers: { 'Content-Type': contentType } })
}

export async function completeUpload(videoId: string) {
  const { data } = await api.post(`/api/videos/${videoId}/complete`)
  return data
}

export async function getVideoDetail(videoId: string) {
  const { data } = await api.get<VideoDetail>(`/api/videos/${videoId}`)
  if (data.url) data.url = API_BASE_URL + data.url
  return data
}
