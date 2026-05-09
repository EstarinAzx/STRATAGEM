/**
 * GitHub Copilot OAuth — device-code → GitHub access token → exchange
 * for short-lived Copilot internal API token.
 *
 * Wire (ported from Tau):
 *   1. POST github.com/login/device/code → { device_code, user_code,
 *      verification_uri, interval, expires_in }.
 *   2. UI shows user_code; opens verification_uri in browser.
 *   3. Poll github.com/login/oauth/access_token with the device_code
 *      until { access_token } returned (or error).
 *   4. With the GitHub token, GET api.github.com/copilot_internal/v2/token
 *      → { token, expires_at, refresh_in, sku, individual, … }.
 *   5. Store the *internal* token as accessToken (it's what api.github
 *      copilot.com accepts). The GitHub token is kept as refreshToken so
 *      step 4 can re-mint when the internal one expires (~30 min TTL).
 */

import { openBrowser } from '../../utils/browser.js'
import { sleep } from './oauthShared.js'
import {
  type StoredOAuthBlob,
  loadOAuth,
  saveOAuth,
} from './oauthStore.js'

// Same hardcoded values Tau / 9router / OpenCode all use. Public installed-
// app credentials per GitHub's OAuth-for-installed-apps spec.
const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98'
const COPILOT_DEVICE_URL = 'https://github.com/login/device/code'
const COPILOT_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const COPILOT_INTERNAL_TOKEN_URL =
  'https://api.github.com/copilot_internal/v2/token'
const COPILOT_USER_AGENT = 'GitHubCopilotChat/0.26.7'

export const COPILOT_STORAGE_KEY = 'copilot_oauth'
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000

export interface CopilotPlanInfo {
  sku?: string
  individual?: boolean
  limitedUserQuotas?: { chat?: number; completions?: number }
  limitedUserResetDate?: number
}

export interface CopilotDeviceHandles {
  userCode: string
  verificationUri: string
  deviceCode: string
  interval: number
  expiresIn: number
}

interface CopilotInternalTokenResponse {
  token?: string
  expires_at?: number
  refresh_in?: number
  sku?: string
  individual?: boolean
  limited_user_quotas?: { chat?: number; completions?: number }
  limited_user_reset_date?: number
}

export async function initiateCopilotOAuth(): Promise<CopilotDeviceHandles> {
  const res = await fetch(COPILOT_DEVICE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      client_id: COPILOT_CLIENT_ID,
      scope: 'read:user',
    }),
  })
  if (!res.ok) {
    throw new Error(`Copilot device-code failed: ${await res.text()}`)
  }
  const data = (await res.json()) as {
    device_code: string
    user_code: string
    verification_uri: string
    expires_in?: number
    interval?: number
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in ?? 900,
    interval: data.interval ?? 5,
  }
}

/** Polling step + Copilot internal token mint. */
export async function completeCopilotOAuth(
  handles: CopilotDeviceHandles,
): Promise<{ accessToken: string; refreshToken: string }> {
  let interval = handles.interval * 1000
  const deadline = Date.now() + handles.expiresIn * 1000
  let ghAccessToken = ''
  while (Date.now() < deadline) {
    await sleep(interval)
    const res = await fetch(COPILOT_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: COPILOT_CLIENT_ID,
        device_code: handles.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })
    const data = (await res.json()) as {
      access_token?: string
      error?: string
      error_description?: string
    }
    if (data.access_token) {
      ghAccessToken = data.access_token
      break
    }
    if (data.error === 'authorization_pending') continue
    if (data.error === 'slow_down') {
      interval += 5000
      continue
    }
    if (data.error === 'expired_token') {
      throw new Error('GitHub device code expired')
    }
    if (data.error === 'access_denied') {
      throw new Error('GitHub authorization denied')
    }
    if (data.error) {
      throw new Error(
        `Copilot OAuth error: ${data.error_description ?? data.error}`,
      )
    }
  }
  if (!ghAccessToken) throw new Error('Copilot OAuth timed out')

  const internal = await mintCopilotInternalToken(ghAccessToken)
  return { accessToken: internal, refreshToken: ghAccessToken }
}

export async function startCopilotOAuth(): Promise<{
  accessToken: string
  refreshToken: string
  userCode: string
  verificationUri: string
}> {
  const handles = await initiateCopilotOAuth()
  await openBrowser(handles.verificationUri)
  const tokens = await completeCopilotOAuth(handles)
  return {
    ...tokens,
    userCode: handles.userCode,
    verificationUri: handles.verificationUri,
  }
}

async function mintCopilotInternalToken(
  ghAccessToken: string,
): Promise<string> {
  const res = await fetch(COPILOT_INTERNAL_TOKEN_URL, {
    headers: {
      Authorization: `Bearer ${ghAccessToken}`,
      Accept: 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': COPILOT_USER_AGENT,
    },
  })
  if (!res.ok) {
    throw new Error(
      `Copilot token mint failed: ${res.status} ${await res.text()}`,
    )
  }
  const data = (await res.json()) as CopilotInternalTokenResponse
  if (!data.token) throw new Error('Copilot: no internal token in response')
  const expiresIn = data.expires_at
    ? Math.max(60, data.expires_at - Math.floor(Date.now() / 1000))
    : 1500
  saveOAuth(COPILOT_STORAGE_KEY, {
    accessToken: data.token,
    refreshToken: ghAccessToken,
    expiresIn,
    meta: copilotMetaFromResponse(data),
  })
  return data.token
}

function copilotMetaFromResponse(
  data: CopilotInternalTokenResponse,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {}
  if (typeof data.refresh_in === 'number') {
    meta.refreshIn = data.refresh_in
    meta.refreshAt = Date.now() + data.refresh_in * 1000
  }
  if (typeof data.sku === 'string') meta.sku = data.sku
  if (typeof data.individual === 'boolean') meta.individual = data.individual
  if (data.limited_user_quotas) {
    meta.limitedUserQuotas = data.limited_user_quotas
  }
  if (typeof data.limited_user_reset_date === 'number') {
    meta.limitedUserResetDate = data.limited_user_reset_date
  }
  return meta
}

function shouldRefresh(blob: StoredOAuthBlob): boolean {
  const refreshAt = blob.meta?.refreshAt
  if (typeof refreshAt === 'number' && Number.isFinite(refreshAt)) {
    return Date.now() > refreshAt - TOKEN_REFRESH_BUFFER_MS
  }
  return !!(blob.expiresAt && Date.now() > blob.expiresAt - TOKEN_REFRESH_BUFFER_MS)
}

export function getCopilotPlanInfo(): CopilotPlanInfo | null {
  const blob = loadOAuth(COPILOT_STORAGE_KEY)
  if (!blob?.meta) return null
  const plan: CopilotPlanInfo = {}
  if (typeof blob.meta.sku === 'string') plan.sku = blob.meta.sku
  if (typeof blob.meta.individual === 'boolean') {
    plan.individual = blob.meta.individual
  }
  const quotas = blob.meta.limitedUserQuotas as
    | { chat?: number; completions?: number }
    | undefined
  if (quotas) plan.limitedUserQuotas = quotas
  if (typeof blob.meta.limitedUserResetDate === 'number') {
    plan.limitedUserResetDate = blob.meta.limitedUserResetDate
  }
  return Object.keys(plan).length ? plan : null
}

let refreshInFlight: Promise<string> | null = null

/**
 * Return a non-expired Copilot internal token, refreshing if needed.
 * Concurrent callers share a single in-flight refresh. Returns null if
 * no credentials are stored or the refresh fails permanently.
 */
export async function getValidCopilotToken(): Promise<string | null> {
  const blob = loadOAuth(COPILOT_STORAGE_KEY)
  if (!blob) return null
  if (!blob.accessToken && !blob.refreshToken) return null

  if (blob.accessToken && !shouldRefresh(blob)) {
    return blob.accessToken
  }

  if (!blob.refreshToken) return blob.accessToken ?? null

  if (!refreshInFlight) {
    refreshInFlight = mintCopilotInternalToken(blob.refreshToken).finally(() => {
      refreshInFlight = null
    })
  }
  try {
    return await refreshInFlight
  } catch {
    // Keep using current token if minted refresh fails — it may still
    // be valid for a few more requests, and surfacing a hard failure
    // here would log out the user on transient network errors.
    return blob.accessToken ?? null
  }
}

export function getCopilotInternalToken(): string | null {
  return loadOAuth(COPILOT_STORAGE_KEY)?.accessToken ?? null
}

/** Editor-shaped headers Copilot's gateway gates non-VSCode UAs by. */
export const COPILOT_HEADERS: Record<string, string> = {
  'Editor-Version': 'vscode/1.110.0',
  'Editor-Plugin-Version': 'copilot-chat/0.38.0',
  'User-Agent': COPILOT_USER_AGENT,
  'Copilot-Integration-Id': 'vscode-chat',
  'Openai-Intent': 'conversation-edits',
}
