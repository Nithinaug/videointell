import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { finishLogin, startLogin } from '../auth'
import { useAuth } from '../context/AuthContext'

export default function AuthCallback() {
  const { signIn } = useAuth()
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true
    finishLogin(new URLSearchParams(location.search))
      .then(({ token, email }) => {
        signIn(token, email)
        navigate('/', { replace: true })
      })
      .catch((e: Error) => setError(e.message))
  }, [signIn, navigate])

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-[#07090c] text-slate-400">
      {error ? (
        <>
          <p className="text-red-300">{error}</p>
          <button onClick={startLogin} className="px-4 py-2 rounded-xl bg-white text-slate-900 font-medium">
            Sign in again
          </button>
        </>
      ) : (
        <p>Signing you in...</p>
      )}
    </div>
  )
}
