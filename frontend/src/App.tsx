import { useEffect } from 'react'
import { Route, BrowserRouter, Routes } from 'react-router-dom'
import { startLogin } from './auth'
import { AuthProvider, useAuth } from './context/AuthContext'
import AuthCallback from './pages/AuthCallback'
import Dashboard from './pages/Dashboard'
import Upload from './pages/Upload'
import VideoDetail from './pages/VideoDetail'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token } = useAuth()
  useEffect(() => {
    if (!token) startLogin()
  }, [token])
  if (!token) return <div className="min-h-screen flex items-center justify-center bg-[#07090c] text-slate-400">Redirecting to sign in...</div>
  return <>{children}</>
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/upload"
        element={
          <ProtectedRoute>
            <Upload />
          </ProtectedRoute>
        }
      />
      <Route
        path="/videos/:id"
        element={
          <ProtectedRoute>
            <VideoDetail />
          </ProtectedRoute>
        }
      />
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  )
}
