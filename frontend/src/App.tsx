import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { useEffect, type ReactNode } from 'react'
import { Route, BrowserRouter, Routes, useLocation } from 'react-router-dom'
import { startLogin } from './auth'
import { AuthProvider, useAuth } from './context/AuthContext'
import AuthCallback from './pages/AuthCallback'
import Dashboard from './pages/Dashboard'
import Search from './pages/Search'
import SharePage from './pages/SharePage'
import Upload from './pages/Upload'
import VideoDetail from './pages/VideoDetail'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token } = useAuth()
  useEffect(() => {
    if (!token) startLogin()
  }, [token])
  if (!token) return <div className="min-h-screen flex items-center justify-center bg-page text-zinc-400">Redirecting to sign in...</div>
  return <>{children}</>
}

function Page({ children }: { children: ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}>
      {children}
    </motion.div>
  )
}

function AppRoutes() {
  const location = useLocation()
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <Routes location={location} key={location.pathname}>
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/share/:token" element={<SharePage />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Page>
                <Dashboard />
              </Page>
            </ProtectedRoute>
          }
        />
        <Route
          path="/search"
          element={
            <ProtectedRoute>
              <Page>
                <Search />
              </Page>
            </ProtectedRoute>
          }
        />
        <Route
          path="/upload"
          element={
            <ProtectedRoute>
              <Page>
                <Upload />
              </Page>
            </ProtectedRoute>
          }
        />
        <Route
          path="/videos/:id"
          element={
            <ProtectedRoute>
              <Page>
                <VideoDetail />
              </Page>
            </ProtectedRoute>
          }
        />
      </Routes>
    </AnimatePresence>
  )
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </MotionConfig>
  )
}
