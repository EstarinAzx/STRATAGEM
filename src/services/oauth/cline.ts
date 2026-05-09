/**
 * Cline OAuth — authorization-code flow with quirky base64-encoded payload.
 *
 * Wire (ported from Tau):
 *   1. Bind a local HTTP server on :3000 (or fallback ephemeral) at /callback.
 *   2. Open api.cline.bot/api/v1/auth/authorize?client_type=extension&...
 *   3. Browser hits /callback?code=... — Cline encodes the entire token
 *      payload (accessToken, refreshToken, email, expiresAt) as base64 in
 *      the `code` param. We decode it directly.
 *   4. Fallback: if the base64 path fails, POST /api/v1/auth/token with
 *      the code and treat it as a normal authorization-code exchange.
 *
 * Refresh: POST /api/v1/auth/refresh with { refreshToken, grantType }.
 */

import { openBrowser } from '../../utils/browser.js'
import { startCallbackServer } from './oauthShared.js'
import { loadOAuth, saveOAuth } from './oauthStore.js'

const CLINE_API_BASE = 'https://api.cline.bot'
export const CLINE_STORAGE_KEY = 'cline_oauth'

interface ClineTokenPayload {
  accessToken?: string
  refreshToken?: string
  email?: string
  expiresAt?: string | number
}

interface ClineTokenExchangeResponse {
  data?: ClineTokenPayload & { userInfo?: { email?: string } }
  accessToken?: string
  refreshToken?: string
  expiresAt?: string | number
}

function expiresInFromAt(value: string | number | undefined): number {
  if (!value) return 3600
  const ms = typeof value === 'string' ? new Date(value).getTime() : value
  if (!Number.isFinite(ms)) return 3600
  return Math.max(60, Math.floor((ms - Date.now()) / 1000))
}

function tryDecodeBase64Code(code: string): ClineTokenPayload | null {
  try {
    let base64 = code
    const pad = 4 - (base64.length % 4)
    if (pad !== 4) base64 += '='.repeat(pad)
    const decoded = Buffer.from(base64, 'base64').toString('utf-8')
    const lastBrace = decoded.lastIndexOf('}')
    if (lastBrace === -1) return null
    const tokenData = JSON.parse(
      decoded.slice(0, lastBrace + 1),
    ) as ClineTokenPayload
    if (!tokenData.accessToken) return null
    return tokenData
  } catch {
    return null
  }
}

export async function startClineOAuth(): Promise<{
  accessToken: string
  refreshToken: string
  authUrl: string
}> {
  const { port, params: paramsPromise } = await startCallbackServer(
    3000,
    ['/callback'],
  )
  const redirectUri = `http://localhost:${port}/callback`

  const authUrl = new URL(`${CLINE_API_BASE}/api/v1/auth/authorize`)
  authUrl.searchParams.set('client_type', 'extension')
  authUrl.searchParams.set('callback_url', redirectUri)
  authUrl.searchParams.set('redirect_uri', redirectUri)

  await openBrowser(authUrl.toString())

  const params = await paramsPromise
  const code = params.get('code')
  if (!code) throw new Error('Cline: no authorization code returned')

  let payload: ClineTokenPayload | null = tryDecodeBase64Code(code)

  if (!payload) {
    const res = await fetch(`${CLINE_API_BASE}/api/v1/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_type: 'extension',
        redirect_uri: redirectUri,
      }),
    })
    if (!res.ok) {
      throw new Error(`Cline token exchange failed: ${await res.text()}`)
    }
    const data = (await res.json()) as ClineTokenExchangeResponse
    payload = {
      accessToken: data.data?.accessToken ?? data.accessToken,
      refreshToken: data.data?.refreshToken ?? data.refreshToken,
      email: data.data?.userInfo?.email,
      expiresAt: data.data?.expiresAt ?? data.expiresAt,
    }
  }

  if (!payload?.accessToken) {
    throw new Error('Cline: no access token received')
  }

  saveOAuth(CLINE_STORAGE_KEY, {
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken || undefined,
    expiresIn: expiresInFromAt(payload.expiresAt),
    meta: { email: payload.email },
  })

  return {
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken ?? '',
    authUrl: authUrl.toString(),
  }
}

export function getClineOAuthToken(): string | null {
  return loadOAuth(CLINE_STORAGE_KEY)?.accessToken ?? null
}

export async function refreshClineOAuth(refreshToken: string): Promise<string> {
  const res = await fetch(`${CLINE_API_BASE}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ refreshToken, grantType: 'refresh_token' }),
  })
  if (!res.ok) {
    throw new Error(`Cline refresh failed: ${await res.text()}`)
  }
  const data = (await res.json()) as ClineTokenExchangeResponse
  const accessToken = data.data?.accessToken ?? data.accessToken
  if (!accessToken) {
    throw new Error('Cline refresh: no access token in response')
  }
  const expiresAt = data.data?.expiresAt ?? data.expiresAt
  saveOAuth(CLINE_STORAGE_KEY, {
    accessToken,
    refreshToken: data.data?.refreshToken ?? data.refreshToken ?? refreshToken,
    expiresIn: expiresInFromAt(expiresAt),
    meta: loadOAuth(CLINE_STORAGE_KEY)?.meta,
  })
  return accessToken
}

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000

/** Returns a non-expired Cline token, refreshing if needed. */
export async function getValidClineToken(): Promise<string | null> {
  const blob = loadOAuth(CLINE_STORAGE_KEY)
  if (!blob?.accessToken) return null
  const stale =
    blob.expiresAt && Date.now() > blob.expiresAt - TOKEN_REFRESH_BUFFER_MS
  if (!stale) return blob.accessToken
  if (!blob.refreshToken) return blob.accessToken
  try {
    return await refreshClineOAuth(blob.refreshToken)
  } catch {
    return blob.accessToken
  }
}
