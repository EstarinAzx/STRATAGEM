/**
 * Cursor OAuth — native browser login (no callback server).
 *
 * Wire (ported from Tau):
 *   1. Generate PKCE pair + uuid.
 *   2. Open cursor.com/loginDeepControl?challenge=...&uuid=... in browser.
 *   3. Poll api2.cursor.sh/auth/poll?uuid=...&verifier=... with exponential
 *      backoff (1s → 10s, max 150 attempts) until { accessToken, refreshToken }.
 *
 * The accessToken is a JWT — we read its `exp` to seed expiresAt. Refresh
 * is not yet wired (Tau's note: "browser sessions are not auto-refreshable
 * yet — re-run /login cursor"); we surface the same constraint here.
 *
 * Note: Cursor's wire format is ConnectRPC/protobuf, not OpenAI-compat.
 * This module only handles auth — actual model calls require a custom
 * lane that's NOT yet implemented in Stratagem.
 */

import { randomUUID } from 'crypto'

import { openBrowser } from '../../utils/browser.js'
import {
  generatePKCE,
  getJwtExpirySeconds,
  sleep,
} from './oauthShared.js'
import { deleteOAuth, loadOAuth, saveOAuth } from './oauthStore.js'

const CURSOR_WEBSITE_BASE =
  process.env.CURSOR_WEBSITE_URL ?? 'https://cursor.com'
const CURSOR_API_BASE =
  process.env.CURSOR_API_BASE_URL ?? 'https://api2.cursor.sh'
const POLL_INITIAL_DELAY_MS = 1000
const POLL_MAX_DELAY_MS = 10_000
const POLL_MAX_ATTEMPTS = 150

export const CURSOR_STORAGE_KEY = 'cursor_oauth'

interface CursorPollPayload {
  accessToken?: string
  refreshToken?: string
}

async function pollForResult(
  uuid: string,
  verifier: string,
): Promise<{ accessToken: string; refreshToken: string } | null> {
  const pollUrl = new URL(`${CURSOR_API_BASE}/auth/poll`)
  pollUrl.searchParams.set('uuid', uuid)
  pollUrl.searchParams.set('verifier', verifier)

  let delayMs = POLL_INITIAL_DELAY_MS
  let consecutiveFailures = 0

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(pollUrl, {
        headers: { 'Content-Type': 'application/json' },
      })

      if (res.status === 404) {
        consecutiveFailures = 0
      } else if (!res.ok) {
        consecutiveFailures += 1
        if (consecutiveFailures >= 3) return null
      } else {
        const data = (await res.json()) as CursorPollPayload
        if (data.accessToken && data.refreshToken) {
          return {
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
          }
        }
        consecutiveFailures += 1
        if (consecutiveFailures >= 3) return null
      }
    } catch {
      consecutiveFailures += 1
      if (consecutiveFailures >= 3) return null
    }

    await sleep(delayMs)
    delayMs = Math.min(delayMs * 2, POLL_MAX_DELAY_MS)
  }

  return null
}

export async function startCursorOAuth(): Promise<{
  accessToken: string
  refreshToken: string
  authUrl: string
}> {
  const { verifier, challenge } = generatePKCE()
  const uuid = randomUUID()

  const authUrl = new URL(`${CURSOR_WEBSITE_BASE}/loginDeepControl`)
  authUrl.searchParams.set('challenge', challenge)
  authUrl.searchParams.set('uuid', uuid)
  authUrl.searchParams.set('mode', 'login')
  authUrl.searchParams.set('redirectTarget', 'cli')

  await openBrowser(authUrl.toString())

  const tokens = await pollForResult(uuid, verifier)
  if (!tokens) {
    throw new Error(
      'Cursor browser login did not complete. Re-run setup and approve the sign-in in your browser.',
    )
  }

  saveOAuth(CURSOR_STORAGE_KEY, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: getJwtExpirySeconds(tokens.accessToken),
    meta: { authMethod: 'browser' },
  })

  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    authUrl: authUrl.toString(),
  }
}

export function getCursorOAuthToken(): string | null {
  return loadOAuth(CURSOR_STORAGE_KEY)?.accessToken ?? null
}

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000

export function getValidCursorToken(): string | null {
  const blob = loadOAuth(CURSOR_STORAGE_KEY)
  if (!blob?.accessToken) return null
  if (
    blob.expiresAt &&
    Date.now() > blob.expiresAt - TOKEN_REFRESH_BUFFER_MS
  ) {
    return null
  }
  return blob.accessToken
}

export function clearCursorToken(): void {
  deleteOAuth(CURSOR_STORAGE_KEY)
}
