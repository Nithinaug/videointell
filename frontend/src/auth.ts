const DOMAIN = import.meta.env.VITE_COGNITO_DOMAIN ?? ''
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID ?? ''
const redirectUri = () => `${location.origin}/auth/callback`

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomString() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function startLogin() {
  const verifier = randomString()
  const state = randomString()
  sessionStorage.setItem('pkce_verifier', verifier)
  sessionStorage.setItem('pkce_state', state)
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    scope: 'openid email',
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  })
  location.assign(`${DOMAIN}/oauth2/authorize?${q}`)
}

export async function finishLogin(params: URLSearchParams) {
  const verifier = sessionStorage.getItem('pkce_verifier')
  const state = sessionStorage.getItem('pkce_state')
  sessionStorage.removeItem('pkce_verifier')
  sessionStorage.removeItem('pkce_state')
  const code = params.get('code')
  if (!code || !verifier || params.get('state') !== state) throw new Error('Sign-in was interrupted. Please try again.')
  const res = await fetch(`${DOMAIN}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT_ID, code, redirect_uri: redirectUri(), code_verifier: verifier }),
  })
  if (!res.ok) throw new Error('Sign-in failed. Please try again.')
  const { id_token } = (await res.json()) as { id_token: string }
  const claims = JSON.parse(atob(id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { email: string; sub: string }
  return { token: id_token, email: claims.email }
}

export function logoutUrl() {
  return `${DOMAIN}/logout?${new URLSearchParams({ client_id: CLIENT_ID, logout_uri: `${location.origin}/` })}`
}
