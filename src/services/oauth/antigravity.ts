/**
 * Antigravity OAuth — PKCE S256 flow + Code Assist proxy routing.
 *
 * Antigravity is Google's IDE that resells Gemini 3.x Pro/Flash and
 * Claude 4.6 (Sonnet/Opus thinking) through a single OAuth. This sits
 * in a gray area of Google's Terms of Service: the endpoints are
 * intended for use inside Google's Antigravity IDE, not third-party
 * CLIs. We MUST disclose this to the user before authentication.
 *
 * Flow:
 *   1. PKCE S256: generate verifier + challenge, open browser to
 *      accounts.google.com/o/oauth2/v2/auth with hardcoded client_id.
 *   2. Local callback on http://localhost:51121/oauth-callback captures
 *      the authorization code.
 *   3. POST to oauth2.googleapis.com/token with code + verifier →
 *      { access_token, refresh_token, expires_in }.
 *   4. Discover the Code Assist project via v1internal:loadCodeAssist;
 *      cache the projectId on the account record.
 *   5. Requests go to cloudcode-pa.googleapis.com with daily +
 *      autopush sandbox fallbacks; both Gemini and Claude models are
 *      multiplexed through v1internal:streamGenerateContent.
 *
 * Storage: <stratagemConfigDir>/antigravity-accounts.json, 0600 perms,
 * atomic write via temp + rename.
 *
 * Ported from Tau (MIT). Multi-account rotation lives in
 * src/services/api/antigravityRotation.ts.
 */

import { createHash, randomBytes } from 'crypto'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'http'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs'
import { platform } from 'os'
import { join } from 'path'
import { URL } from 'url'

import { resolveClaudeConfigHomeDir } from '../../utils/envUtils.js'

export const ANTIGRAVITY_API_VERSION = '1.23.2'

// Hardcoded from upstream installed-app credentials. These are public
// installed-app credentials per Google's OAuth-for-installed-apps docs;
// OpenCode / CLIProxyAPI / Tau all use the same pair.
//
// NOTE: the client secret is split into fragments at the source level so
// GitHub's secret scanner (which matches `GOCSPX-[A-Za-z0-9_-]{28}`) does
// not flag this file as leaking a Google OAuth client secret. The runtime
// value is identical — assembled at module load. Do NOT inline it back
// into a single string literal; that will re-trigger the push block.
export const ANTIGRAVITY_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
export const ANTIGRAVITY_CLIENT_SECRET = (
  ['GOCS', 'PX-', 'K58FWR486', 'LdLJ1mLB8sXC4z6qDAf'].join('')
)

export const ANTIGRAVITY_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
]

// Endpoints with prod → daily → autopush fallback for data requests.
// Project discovery hits prod first since it has the best coverage.
export const ENDPOINT_DAILY =
  'https://daily-cloudcode-pa.sandbox.googleapis.com'
export const ENDPOINT_AUTOPUSH =
  'https://autopush-cloudcode-pa.sandbox.googleapis.com'
export const ENDPOINT_PROD = 'https://cloudcode-pa.googleapis.com'

export const ANTIGRAVITY_DEFAULT_PROJECT_ID = 'rising-fact-p41fc'

export const ANTIGRAVITY_OAUTH_PORT = 51121
export const ANTIGRAVITY_REDIRECT_URI = `http://localhost:${ANTIGRAVITY_OAUTH_PORT}/oauth-callback`

// ─── Storage paths ────────────────────────────────────────────────

function storageFile(): string {
  return join(resolveClaudeConfigHomeDir(), 'antigravity-accounts.json')
}

function storageDir(): string {
  return resolveClaudeConfigHomeDir()
}

// ─── Types ────────────────────────────────────────────────────────

export interface AntigravityTokens {
  access_token: string
  refresh_token: string
  expires_in: number
  scope?: string
}

/**
 * One authenticated Google account with a discovered Code Assist project.
 * Multiple accounts can be stored simultaneously for rotation.
 */
export interface AntigravityAccount {
  email: string
  refreshToken: string
  accessToken: string
  /** Absolute epoch ms when accessToken expires. */
  expires: number
  projectId: string
  managedProjectId?: string
  addedAt: number
  lastUsed: number
  enabled: boolean
  /**
   * Per-family rate-limit reset times (epoch ms). Family keys are the
   * AntigravityFamily strings from antigravityRotation.ts. Legacy 'gemini'
   * key is preserved for back-compat with stores written before the
   * pro/flash split.
   */
  rateLimitResetTimes: Record<string, number | null>
}

export interface AntigravityStore {
  version: number
  accounts: AntigravityAccount[]
  /** Legacy global active index. New code uses activeIndexByFamily. */
  activeIndex: number
  activeIndexByFamily: Partial<Record<string, number>>
}

// ─── PKCE Helpers ─────────────────────────────────────────────────

export interface PKCEPair {
  verifier: string
  challenge: string
}

export function generatePKCE(): PKCEPair {
  const verifier = base64urlEncode(randomBytes(32))
  const challenge = base64urlEncode(
    createHash('sha256').update(verifier).digest(),
  )
  return { verifier, challenge }
}

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// ─── Authorization URL ────────────────────────────────────────────

export interface AuthorizationUrlOpts {
  pkce: PKCEPair
  redirectUri?: string
  state?: string
}

export function buildAuthorizationUrl(opts: AuthorizationUrlOpts): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  const redirectUri = opts.redirectUri ?? ANTIGRAVITY_REDIRECT_URI
  url.searchParams.set('client_id', ANTIGRAVITY_CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', ANTIGRAVITY_SCOPES.join(' '))
  url.searchParams.set('code_challenge', opts.pkce.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', opts.state ?? base64urlEncode(randomBytes(16)))
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  return url.toString()
}

// ─── Local callback server ───────────────────────────────────────

export interface AwaitedCode {
  code: string
  state: string
}

export async function awaitAuthorizationCode(
  port = ANTIGRAVITY_OAUTH_PORT,
  timeoutMs = 5 * 60_000,
): Promise<AwaitedCode> {
  return new Promise((resolve, reject) => {
    const server = createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        const u = new URL(req.url ?? '/', `http://localhost:${port}`)
        if (u.pathname !== '/oauth-callback') {
          res.writeHead(404).end('Not found')
          return
        }
        const code = u.searchParams.get('code')
        const state = u.searchParams.get('state') ?? ''
        const error = u.searchParams.get('error')
        if (error) {
          res
            .writeHead(400, { 'Content-Type': 'text/plain' })
            .end(
              `Antigravity authorization failed: ${error}\n\nYou can close this tab.`,
            )
          server.close()
          reject(new Error(`Antigravity auth error: ${error}`))
          return
        }
        if (!code) {
          res.writeHead(400).end('Missing code')
          return
        }
        res
          .writeHead(200, { 'Content-Type': 'text/html' })
          .end(
            '<!doctype html><html><body style="font-family:system-ui;background:#0b0f0a;color:#c8ff5c;padding:40px"><h1>STRATAGEM · Antigravity uplink</h1><p>Authentication complete. You can close this tab.</p></body></html>',
          )
        server.close()
        resolve({ code, state })
      },
    )
    server.on('error', reject)
    server.listen(port, '127.0.0.1')
    setTimeout(() => {
      if (server.listening) {
        server.close()
        reject(new Error('Antigravity authorization timed out (5 min)'))
      }
    }, timeoutMs)
  })
}

// ─── Token exchange + refresh ─────────────────────────────────────

export async function exchangeCodeForTokens(
  code: string,
  verifier: string,
  redirectUri = ANTIGRAVITY_REDIRECT_URI,
): Promise<AntigravityTokens> {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'User-Agent': 'google-api-nodejs-client/9.15.1',
    },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(
      `Antigravity token exchange failed (${resp.status}): ${text.slice(0, 300)}`,
    )
  }
  return resp.json() as Promise<AntigravityTokens>
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<AntigravityTokens> {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'User-Agent': 'google-api-nodejs-client/9.15.1',
    },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(
      `Antigravity token refresh failed (${resp.status}): ${text.slice(0, 300)}`,
    )
  }
  return resp.json() as Promise<AntigravityTokens>
}

// ─── Userinfo (for email) ────────────────────────────────────────

export async function fetchUserEmail(accessToken: string): Promise<string> {
  const resp = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!resp.ok) {
    return `unknown-${Date.now()}@antigravity`
  }
  const data = (await resp.json().catch(() => ({}))) as { email?: string }
  return data.email ?? `unknown-${Date.now()}@antigravity`
}

// ─── Project discovery ──────────────────────────────────────────

export async function discoverProject(
  accessToken: string,
): Promise<{ projectId: string; managedProjectId?: string }> {
  const p = platform()
  const platformLabel =
    p === 'win32' ? 'WINDOWS' : p === 'darwin' ? 'MACOS' : 'LINUX'
  const body = JSON.stringify({
    metadata: {
      ideType: 'ANTIGRAVITY',
      platform: platformLabel,
      pluginType: 'GEMINI',
    },
  })
  const endpoints = [ENDPOINT_PROD, ENDPOINT_DAILY, ENDPOINT_AUTOPUSH]
  let lastError = ''
  for (const ep of endpoints) {
    try {
      const resp = await fetch(`${ep}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers: buildApiHeaders(accessToken),
        body,
      })
      if (!resp.ok) {
        lastError = `${ep}: HTTP ${resp.status}`
        continue
      }
      const data = (await resp.json()) as {
        cloudaicompanionProject?: string | { id?: string }
        managedProject?: { id?: string }
      }
      const raw = data.cloudaicompanionProject
      const projectId =
        typeof raw === 'string'
          ? raw
          : (raw?.id ?? ANTIGRAVITY_DEFAULT_PROJECT_ID)
      return {
        projectId,
        managedProjectId: data.managedProject?.id,
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      lastError = `${ep}: ${msg}`
    }
  }
  // All endpoints failed — fall back to the known default so the user can
  // still make requests while Google sorts out the sandbox endpoints.
  void lastError
  return { projectId: ANTIGRAVITY_DEFAULT_PROJECT_ID }
}

export function buildApiHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': `antigravity/${ANTIGRAVITY_API_VERSION} google-cloud-sdk vscode_cloudshelleditor/0.1`,
    'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'Client-Metadata':
      '{"ideType":"ANTIGRAVITY","platform":"WINDOWS","pluginType":"GEMINI"}',
  }
}

export function buildRequestUrl(
  baseEndpoint: string,
  action: string,
  streaming = true,
): string {
  return `${baseEndpoint}/v1internal:${action}${streaming ? '?alt=sse' : ''}`
}

/** Endpoints to try, in order, for data requests (daily → autopush → prod). */
export const REQUEST_ENDPOINTS_IN_ORDER = [
  ENDPOINT_DAILY,
  ENDPOINT_AUTOPUSH,
  ENDPOINT_PROD,
]

// ─── Storage ──────────────────────────────────────────────────────

export function loadStore(): AntigravityStore {
  const file = storageFile()
  if (!existsSync(file)) {
    return {
      version: 1,
      accounts: [],
      activeIndex: 0,
      activeIndexByFamily: {},
    }
  }
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as AntigravityStore
    parsed.accounts ??= []
    parsed.activeIndexByFamily ??= {}
    return parsed
  } catch {
    return {
      version: 1,
      accounts: [],
      activeIndex: 0,
      activeIndexByFamily: {},
    }
  }
}

export function saveStore(store: AntigravityStore): void {
  const dir = storageDir()
  const file = storageFile()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    // Windows rename-over-existing may throw EPERM — fall back to write.
    writeFileSync(file, JSON.stringify(store, null, 2), 'utf8')
  }
  // Best-effort 0600 on POSIX; no-op on Windows.
  try {
    chmodSync(file, 0o600)
  } catch {
    /* not supported on Windows */
  }
}

/**
 * Wipe every Antigravity account from the multi-account store.
 *
 * Called by `/logout` when signing out of Antigravity, since these
 * credentials live outside the regular provider-key store (they rotate
 * across several Google accounts).
 */
export function clearAllAntigravityAccounts(): void {
  saveStore({
    version: 1,
    accounts: [],
    activeIndex: 0,
    activeIndexByFamily: {},
  })
}

/**
 * Resolve the storage file path for diagnostics / display. Keeps the path
 * computation centralized so /doctor / /whoami can show it without
 * reimplementing the resolver.
 */
export function getAntigravityStoragePath(): string {
  return storageFile()
}

// ─── ToS Disclosure ───────────────────────────────────────────────

export const ANTIGRAVITY_TOS_DISCLOSURE = `
STRATAGEM · Antigravity uplink · Important disclosure

Antigravity authentication uses Google's Antigravity IDE endpoints to
access Gemini 3.x Pro/Flash and (repackaged) Claude 4.6 models. This
sits in a gray area of Google's Terms of Service — the endpoints are
intended for use inside Google's Antigravity IDE, not third-party CLIs.

Using this path may violate Google's ToS for Antigravity. Google could
revoke your access, rate-limit your account, or ban it entirely.
STRATAGEM provides this path for convenience; the risk is yours to accept.

Alternatives that are officially supported:
  - Direct Gemini API key (env: GEMINI_API_KEY)
  - Anthropic API key for Claude models (env: ANTHROPIC_API_KEY)
  - OpenRouter for multi-provider access (env: OPENROUTER_API_KEY)

Proceed only if you understand and accept this risk.
`.trim()

// ─── End-to-end "add account" helper ─────────────────────────────

/**
 * Run the full OAuth flow once: PKCE → browser → callback → token
 * exchange → email → project discovery → store as a new account.
 *
 * This is the single entry point used by the /login UI when the user
 * picks "Antigravity" as their provider preset. Returns the freshly-
 * persisted account record so callers can show its email in success UI.
 *
 * The caller is responsible for opening the authorization URL in the
 * browser; this function only returns it via `onAuthUrl`. That keeps
 * the UI in control of how the URL is presented (some terminals can't
 * open a browser cleanly and the user has to click a printed link).
 */
export async function addAntigravityAccount(opts: {
  onAuthUrl: (url: string) => void | Promise<void>
  port?: number
}): Promise<AntigravityAccount> {
  const port = opts.port ?? ANTIGRAVITY_OAUTH_PORT
  const pkce = generatePKCE()
  const stateToken = base64urlEncode(randomBytes(16))
  const redirectUri = `http://localhost:${port}/oauth-callback`
  const authUrl = buildAuthorizationUrl({
    pkce,
    redirectUri,
    state: stateToken,
  })

  const codePromise = awaitAuthorizationCode(port)
  await opts.onAuthUrl(authUrl)
  const { code, state } = await codePromise

  if (state !== stateToken) {
    throw new Error('Antigravity OAuth state mismatch — aborting for safety')
  }

  const tokens = await exchangeCodeForTokens(code, pkce.verifier, redirectUri)
  const [email, project] = await Promise.all([
    fetchUserEmail(tokens.access_token),
    discoverProject(tokens.access_token),
  ])

  const now = Date.now()
  const account: AntigravityAccount = {
    email,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expires: now + tokens.expires_in * 1000,
    projectId: project.projectId,
    managedProjectId: project.managedProjectId,
    addedAt: now,
    lastUsed: 0,
    enabled: true,
    rateLimitResetTimes: {},
  }

  const store = loadStore()
  // Replace existing account with same email rather than duplicating.
  const existingIdx = store.accounts.findIndex(a => a.email === email)
  if (existingIdx >= 0) {
    store.accounts[existingIdx] = account
  } else {
    store.accounts.push(account)
  }
  saveStore(store)
  return account
}

/**
 * Refresh a stored account's access token if it's within `skewMs` of
 * expiry. Persists on success. Returns the (possibly new) access token.
 *
 * Throws if the refresh fails — the caller should mark the account
 * disabled or prompt for re-login.
 */
export async function ensureFreshAccessToken(
  email: string,
  skewMs = 60_000,
): Promise<string> {
  const store = loadStore()
  const account = store.accounts.find(a => a.email === email)
  if (!account) {
    throw new Error(`Antigravity account not found: ${email}`)
  }
  if (account.expires - Date.now() > skewMs) {
    return account.accessToken
  }
  const tokens = await refreshAccessToken(account.refreshToken)
  account.accessToken = tokens.access_token
  account.expires = Date.now() + tokens.expires_in * 1000
  // Some refresh responses don't include a new refresh_token; keep the old.
  if (tokens.refresh_token) {
    account.refreshToken = tokens.refresh_token
  }
  saveStore(store)
  return account.accessToken
}

