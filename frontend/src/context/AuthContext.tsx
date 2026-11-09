import { createContext, useContext, useState, type ReactNode } from 'react'
import { logoutUrl } from '../auth'

interface AuthUser {
  email: string
}

interface AuthContextValue {
  user: AuthUser | null
  token: string | null
  signIn: (token: string, email: string) => void
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function clearSession() {
  localStorage.removeItem('token')
  localStorage.removeItem('user')
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'))
  const [user, setUser] = useState<AuthUser | null>(() => {
    const raw = localStorage.getItem('user')
    return raw ? JSON.parse(raw) : null
  })

  function signIn(token: string, email: string) {
    localStorage.setItem('token', token)
    localStorage.setItem('user', JSON.stringify({ email }))
    setToken(token)
    setUser({ email })
  }

  function logout() {
    clearSession()
    location.assign(logoutUrl())
  }

  return <AuthContext.Provider value={{ user, token, signIn, logout }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
