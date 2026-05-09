/**
 * KiloCode OAuth — custom device-auth flow (no spec, just their endpoints).
 *
 * Wire (ported from Tau):
 *   1. POST api.kilo.ai/api/device-auth/codes → { code, verificationUrl, expiresIn }.
 *   2. UI opens verificationUrl; user approves.
 *   3. Poll GET /api/device-auth/codes/<code>:
 *        202 → pending, 403 → denied, 410 → expired,
 *        200 with { status: 'approved', token } → done.
 *   4. Best-effort GET /api/profile to grab orgId for the
 *      X-Kilocode-OrganizationID header on subsequent requests.
 *
 * Tokens are long-lived; no refresh endpoint. Re-auth required if revoked.
 */

import { openBrowser } from '../../utils/browser.js'
import { sleep } from './oauthShared.js'
import { loadOAuth, saveOAuth } from './oauthStore.js'

const KILOCODE_API_BASE = 'https://api.kilo.ai'
export const KILOCODE_STORAGE_KEY = 'kilocode_oauth'

export interface KiloCodeHandles {
  /** Display this in the UI so the user can verify the device they just opened. */
  code: string
  verificationUrl: string
  expiresIn: number
}

export async function initiateKiloCodeOAuth(): Promise<KiloCodeHandles> {
  const res = await fetch(`${KILOCODE_API_BASE}/api/device-auth/codes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`KiloCode device auth failed: ${await res.text()}`)
  }
  const data = (await res.json()) as {
    code: string
    verificationUrl: string
    expiresIn?: number
  }
  return {
    code: data.code,
    verificationUrl: data.verificationUrl,
    expiresIn: data.expiresIn ?? 300,
  }
}

export async function completeKiloCodeOAuth(
  handles: KiloCodeHandles,
): Promise<{ accessToken: string; refreshToken: string }> {
  const pollUrl = `${KILOCODE_API_BASE}/api/device-auth/codes/${handles.code}`
  const deadline = Date.now() + handles.expiresIn * 1000
  while (Date.now() < deadline) {
    await sleep(3000)
    const res = await fetch(pollUrl)
    if (res.status === 202) continue
    if (res.status === 403) {
      throw new Error('KiloCode authorization denied by user')
    }
    if (res.status === 410) {
      throw new Error('KiloCode authorization code expired')
    }
    if (!res.ok) continue
    const data = (await res.json()) as {
      status?: string
      token?: string
      userEmail?: string
    }
    if (data.status === 'approved' && data.token) {
      let orgId: string | null = null
      try {
        const profileRes = await fetch(`${KILOCODE_API_BASE}/api/profile`, {
          headers: { Authorization: `Bearer ${data.token}` },
        })
        if (profileRes.ok) {
          const profile = (await profileRes.json()) as {
            organizations?: Array<{ id?: string }>
          }
          orgId = profile.organizations?.[0]?.id ?? null
        }
      } catch {
        /* best-effort; orgId is optional */
      }
      saveOAuth(KILOCODE_STORAGE_KEY, {
        accessToken: data.token,
        meta: { email: data.userEmail, orgId },
      })
      return { accessToken: data.token, refreshToken: '' }
    }
  }
  throw new Error('KiloCode authorization timed out')
}

export async function startKiloCodeOAuth(): Promise<{
  accessToken: string
  refreshToken: string
  code: string
  verificationUrl: string
}> {
  const handles = await initiateKiloCodeOAuth()
  await openBrowser(handles.verificationUrl)
  const tokens = await completeKiloCodeOAuth(handles)
  return {
    ...tokens,
    code: handles.code,
    verificationUrl: handles.verificationUrl,
  }
}

export function getKiloCodeOAuthToken(): string | null {
  return loadOAuth(KILOCODE_STORAGE_KEY)?.accessToken ?? null
}

export function getKiloCodeOrgId(): string | null {
  const blob = loadOAuth(KILOCODE_STORAGE_KEY)
  return (blob?.meta?.orgId as string) ?? null
}

/** Header KiloCode requires when an org is set. Empty if no org. */
export function kiloCodeHeaders(): Record<string, string> {
  const orgId = getKiloCodeOrgId()
  return orgId ? { 'X-Kilocode-OrganizationID': orgId } : {}
}
