/**
 * Kiro OAuth — AWS SSO OIDC device-code (Builder ID path).
 *
 * Wire (ported from Tau):
 *   1. POST oidc.us-east-1.amazonaws.com/client/register with our hardcoded
 *      clientName/scopes → { clientId, clientSecret }. (These are dynamic
 *      per-installation; not real secrets.)
 *   2. POST /device_authorization → { deviceCode, userCode, verificationUri,
 *      verificationUriComplete, interval, expiresIn }.
 *   3. UI shows userCode; opens verificationUriComplete in browser.
 *   4. Poll /token until { accessToken, refreshToken, expiresIn }.
 *
 * Refresh: POST /token with grantType=refresh_token + the original
 * clientId/clientSecret (stored in meta).
 *
 * Note: Kiro's chat wire format is AWS CodeWhisperer EventStream (binary
 * protobuf), not OpenAI-compat. This module only handles auth — actual
 * model calls require a custom lane that's NOT yet implemented in
 * Stratagem.
 */

import { openBrowser } from '../../utils/browser.js'
import { sleep } from './oauthShared.js'
import { loadOAuth, saveOAuth } from './oauthStore.js'

const KIRO_OIDC_BASE = 'https://oidc.us-east-1.amazonaws.com'
const KIRO_BUILDER_START_URL = 'https://view.awsapps.com/start'
const KIRO_CLIENT_NAME = 'kiro-oauth-client'
const KIRO_SCOPES = [
  'codewhisperer:completions',
  'codewhisperer:analysis',
  'codewhisperer:conversations',
]
const KIRO_GRANT_TYPES = [
  'urn:ietf:params:oauth:grant-type:device_code',
  'refresh_token',
]
const KIRO_ISSUER_URL =
  'https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6'

export const KIRO_STORAGE_KEY = 'kiro_oauth'
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000

export interface KiroDeviceHandles {
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  deviceCode: string
  interval: number
  expiresIn: number
  clientId: string
  clientSecret: string
}

interface KiroTokenPayload {
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
}

function pickString(
  data: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const v = data[key]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

function pickNumber(
  data: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const v = data[key]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

function normalizeKiroPayload(
  data: Record<string, unknown>,
): KiroTokenPayload {
  return {
    accessToken: pickString(data, 'accessToken', 'access_token'),
    refreshToken: pickString(data, 'refreshToken', 'refresh_token'),
    expiresIn: pickNumber(data, 'expiresIn', 'expires_in'),
  }
}

export async function initiateKiroOAuth(): Promise<KiroDeviceHandles> {
  const registerRes = await fetch(`${KIRO_OIDC_BASE}/client/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientName: KIRO_CLIENT_NAME,
      clientType: 'public',
      scopes: KIRO_SCOPES,
      grantTypes: KIRO_GRANT_TYPES,
      issuerUrl: KIRO_ISSUER_URL,
    }),
  })
  if (!registerRes.ok) {
    throw new Error(`Kiro client register failed: ${await registerRes.text()}`)
  }
  const client = (await registerRes.json()) as {
    clientId: string
    clientSecret: string
  }

  const authRes = await fetch(`${KIRO_OIDC_BASE}/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      startUrl: KIRO_BUILDER_START_URL,
    }),
  })
  if (!authRes.ok) {
    throw new Error(`Kiro device auth failed: ${await authRes.text()}`)
  }
  const auth = (await authRes.json()) as {
    deviceCode: string
    userCode: string
    verificationUri: string
    verificationUriComplete: string
    expiresIn?: number
    interval?: number
  }
  return {
    deviceCode: auth.deviceCode,
    userCode: auth.userCode,
    verificationUri: auth.verificationUri,
    verificationUriComplete: auth.verificationUriComplete,
    expiresIn: auth.expiresIn ?? 900,
    interval: auth.interval ?? 5,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
  }
}

export async function completeKiroOAuth(
  handles: KiroDeviceHandles,
): Promise<{ accessToken: string; refreshToken: string }> {
  let interval = handles.interval * 1000
  const deadline = Date.now() + handles.expiresIn * 1000
  while (Date.now() < deadline) {
    await sleep(interval)
    const res = await fetch(`${KIRO_OIDC_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: handles.clientId,
        clientSecret: handles.clientSecret,
        deviceCode: handles.deviceCode,
        grantType: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })
    const raw = (await res.json()) as Record<string, unknown> & {
      error?: string
      error_description?: string
    }
    const data = normalizeKiroPayload(raw)
    if (data.accessToken) {
      saveOAuth(KIRO_STORAGE_KEY, {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresIn: data.expiresIn,
        meta: {
          authMethod: 'builder-id',
          clientId: handles.clientId,
          clientSecret: handles.clientSecret,
          region: 'us-east-1',
        },
      })
      return {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken ?? '',
      }
    }
    if (raw.error === 'authorization_pending') continue
    if (raw.error === 'slow_down') {
      interval += 5000
      continue
    }
    if (raw.error === 'expired_token') {
      throw new Error('Kiro device code expired')
    }
    if (raw.error === 'access_denied') {
      throw new Error('Kiro authorization denied')
    }
    if (raw.error) {
      throw new Error(`Kiro OAuth error: ${raw.error_description ?? raw.error}`)
    }
  }
  throw new Error('Kiro authorization timed out')
}

export async function startKiroOAuth(): Promise<{
  accessToken: string
  refreshToken: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
}> {
  const handles = await initiateKiroOAuth()
  await openBrowser(handles.verificationUriComplete || handles.verificationUri)
  const tokens = await completeKiroOAuth(handles)
  return {
    ...tokens,
    userCode: handles.userCode,
    verificationUri: handles.verificationUri,
    verificationUriComplete: handles.verificationUriComplete,
  }
}

export async function refreshKiroOAuth(refreshToken: string): Promise<string> {
  const blob = loadOAuth(KIRO_STORAGE_KEY)
  const clientId = blob?.meta?.clientId as string | undefined
  const clientSecret = blob?.meta?.clientSecret as string | undefined
  if (!clientId || !clientSecret) {
    throw new Error(
      'Kiro refresh: client credentials missing — re-run /provider Kiro to relogin.',
    )
  }
  const res = await fetch(`${KIRO_OIDC_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId,
      clientSecret,
      refreshToken,
      grantType: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`Kiro refresh failed: ${await res.text()}`)
  const data = normalizeKiroPayload(await res.json() as Record<string, unknown>)
  if (!data.accessToken) {
    throw new Error('Kiro refresh: no access token in response')
  }
  saveOAuth(KIRO_STORAGE_KEY, {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken ?? refreshToken,
    expiresIn: data.expiresIn,
    meta: blob?.meta,
  })
  return data.accessToken
}

export function getKiroOAuthToken(): string | null {
  return loadOAuth(KIRO_STORAGE_KEY)?.accessToken ?? null
}

export async function getValidKiroToken(): Promise<string | null> {
  const blob = loadOAuth(KIRO_STORAGE_KEY)
  if (!blob?.accessToken) return null
  const stale =
    blob.expiresAt && Date.now() > blob.expiresAt - TOKEN_REFRESH_BUFFER_MS
  if (!stale) return blob.accessToken
  if (!blob.refreshToken) return null
  try {
    return await refreshKiroOAuth(blob.refreshToken)
  } catch {
    return null
  }
}
