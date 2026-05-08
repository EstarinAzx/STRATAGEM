/**
 * Antigravity shim — duck-types as the Anthropic SDK so claude.ts can
 * stream through Google's Code Assist proxy without knowing it's not
 * talking to Anthropic directly.
 *
 * Wire flow per request:
 *   1. Pick an account from the rotation manager (per model family).
 *   2. Refresh the access token if it's near expiry.
 *   3. Convert Anthropic request → Gemini generateContent.
 *   4. Wrap in the Code Assist envelope (project, sessionId, userAgent).
 *   5. POST to one of the Code Assist endpoints (prod → daily → autopush
 *      fallback chain). The first non-5xx response wins.
 *   6. Parse the SSE stream, unwrap each {response: ...} envelope, and
 *      convert Gemini chunks → Anthropic stream events.
 *   7. Record success / rate-limit / hard-failure on the rotation tracker.
 *
 * Mirrors openaiShim's public surface so client.ts can swap it in:
 *   client.beta.messages.create(params, options) → Promise<Stream | Message>
 *   stream has `controller` + `[Symbol.asyncIterator]()`
 *   non-stream promise has `.withResponse() → {data, response, request_id}`
 */

import { APIError } from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'

import {
  type AntigravityAccount,
  buildApiHeaders,
  ensureFreshAccessToken,
  REQUEST_ENDPOINTS_IN_ORDER,
} from '../oauth/antigravity.js'
import {
  type AntigravityFamily,
  familyForAntigravityModel,
  getAntigravityRotation,
} from './antigravityRotation.js'
import {
  antigravityApiHeaders,
  parseCodeAssistSSE,
  streamGenerateContentUrl,
  generateContentUrl,
  unwrapCodeAssistResponse,
  wrapForCodeAssist,
} from './antigravityCodeAssist.js'
import { anthropicToGeminiRequest } from './anthropicToGemini.js'
import {
  geminiMessageToAnthropic,
  geminiStreamToAnthropicEvents,
} from './geminiToAnthropic.js'
import type { AnthropicStreamEvent, ShimCreateParams } from './codexShim.js'

// ─── Stream wrapper ──────────────────────────────────────────────

class AntigravityShimStream {
  private generator: AsyncGenerator<AnthropicStreamEvent>
  // Checked by claude.ts to distinguish streams from error messages.
  controller = new AbortController()

  constructor(generator: AsyncGenerator<AnthropicStreamEvent>) {
    this.generator = generator
  }

  async *[Symbol.asyncIterator]() {
    yield* this.generator
  }
}

// ─── Error helpers ───────────────────────────────────────────────

function parseRetryAfterMs(headers: Headers): number | undefined {
  const retryAfter = headers.get('retry-after')
  if (!retryAfter) return undefined
  // Spec allows seconds OR an HTTP date. Try seconds first.
  const sec = parseInt(retryAfter, 10)
  if (!isNaN(sec) && sec > 0) return sec * 1000
  const dateMs = Date.parse(retryAfter)
  if (!isNaN(dateMs)) {
    const delta = dateMs - Date.now()
    return delta > 0 ? delta : undefined
  }
  return undefined
}

/**
 * Extract a server-specified retry delay from a Code Assist 429 body.
 * Google encodes this as `RetryInfo` in the error details:
 *   { error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo",
 *                          retryDelay: "60s" }] } }
 */
function parseRetryInfoFromBody(body: string): number | undefined {
  try {
    const parsed = JSON.parse(body) as {
      error?: { details?: Array<Record<string, unknown>> }
    }
    const details = parsed.error?.details
    if (!Array.isArray(details)) return undefined
    for (const d of details) {
      const t = d['@type'] as string | undefined
      if (typeof t === 'string' && t.includes('RetryInfo')) {
        const delay = d.retryDelay as string | undefined
        if (typeof delay === 'string') {
          const m = delay.match(/^(\d+(?:\.\d+)?)s$/)
          if (m) return Math.ceil(parseFloat(m[1]!) * 1000)
        }
      }
    }
  } catch {
    // ignore
  }
  return undefined
}

function isRateLimitStatus(status: number): boolean {
  return status === 429 || status === 503
}

function isAuthFailureStatus(status: number): boolean {
  return status === 401 || status === 403
}

// ─── Endpoint dispatch ───────────────────────────────────────────

/**
 * POST the wrapped request to each endpoint in the fallback chain. The
 * first non-5xx response wins. If every endpoint 5xx's, the last one is
 * returned so the caller can surface its error.
 *
 * On 429 / 503 with retry info, we attach the parsed cooldown to the
 * Response object via a custom property so the caller can record it on
 * the rotation tracker.
 */
async function dispatchToCodeAssist(opts: {
  accessToken: string
  body: unknown
  streaming: boolean
  signal?: AbortSignal
}): Promise<Response> {
  const url = (base: string) =>
    opts.streaming ? streamGenerateContentUrl(base) : generateContentUrl(base)
  const bodyJson = JSON.stringify(opts.body)
  const headers = antigravityApiHeaders(opts.accessToken)

  let lastResponse: Response | undefined
  for (const endpoint of REQUEST_ENDPOINTS_IN_ORDER) {
    const response = await fetch(url(endpoint), {
      method: 'POST',
      headers,
      body: bodyJson,
      signal: opts.signal,
    })
    if (response.ok) return response
    // Retry on 5xx (transient). Surface 4xx (terminal) immediately.
    if (response.status < 500) return response
    lastResponse = response
  }
  return lastResponse ?? new Response(null, { status: 500 })
}

// ─── Account selection + token refresh ───────────────────────────

interface ResolvedAccount {
  account: AntigravityAccount
  family: AntigravityFamily
  accessToken: string
}

async function resolveAccountForRequest(
  model: string,
): Promise<ResolvedAccount> {
  const rotation = getAntigravityRotation()
  if (!rotation.hasAccounts()) {
    throw new APIError(
      401,
      undefined,
      'No Antigravity accounts configured. Run /login and pick "Antigravity" to add one.',
      undefined,
    )
  }
  const family = familyForAntigravityModel(model)
  const account = rotation.pickForFamily(family)
  if (!account) {
    const next = rotation.nextRecoveryAt()
    const waitS = next ? Math.max(1, Math.ceil((next - Date.now()) / 1000)) : 0
    throw new APIError(
      429,
      undefined,
      waitS > 0
        ? `All Antigravity accounts are rate-limited for "${family}". Next account available in ~${waitS}s.`
        : `All Antigravity accounts are disabled. Re-authenticate via /login.`,
      undefined,
    )
  }
  const accessToken = await ensureFreshAccessToken(account.email).catch(
    (e: unknown) => {
      // Refresh failed — likely revoked refresh token. Mark hard failure
      // so rotation will skip this account, and bubble.
      rotation.recordHardFailure(account)
      throw e
    },
  )
  return { account, family, accessToken }
}

// ─── Non-streaming response → Anthropic Message ──────────────────

async function readNonStreaming(
  response: Response,
  model: string,
): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    const text = await response.text().catch(() => '')
    throw APIError.generate(
      response.status,
      undefined,
      `Antigravity non-streaming response was not JSON: ${text.slice(0, 300)}`,
      response.headers as unknown as Headers,
    )
  }
  const wrapped = await response.json()
  const inner = unwrapCodeAssistResponse(wrapped)
  return geminiMessageToAnthropic(inner, model)
}

// ─── Error response → APIError ───────────────────────────────────

async function buildApiErrorFromResponse(
  response: Response,
  resolved: ResolvedAccount,
): Promise<APIError> {
  const text = await response.text().catch(() => '')
  if (isRateLimitStatus(response.status)) {
    const cooldownMs =
      parseRetryInfoFromBody(text) ??
      parseRetryAfterMs(response.headers as unknown as Headers)
    getAntigravityRotation().recordRateLimit(
      resolved.account,
      resolved.family,
      cooldownMs,
    )
  } else if (isAuthFailureStatus(response.status)) {
    getAntigravityRotation().recordHardFailure(resolved.account)
  } else if (response.status >= 500) {
    // Server error — don't disable the account, just record a soft failure.
    getAntigravityRotation().recordHardFailure(resolved.account)
  }
  return APIError.generate(
    response.status,
    undefined,
    `Antigravity API error ${response.status}: ${text.slice(0, 500)}`,
    response.headers as unknown as Headers,
  )
}

// ─── Shim messages class ─────────────────────────────────────────

class AntigravityShimMessages {
  create(
    params: ShimCreateParams,
    options?: { signal?: AbortSignal; headers?: Record<string, string> },
  ) {
    const self = this
    let httpResponse: Response | undefined

    const promise = (async () => {
      const resolved = await resolveAccountForRequest(params.model)

      const geminiBody = anthropicToGeminiRequest(params)
      const wrapped = wrapForCodeAssist(
        params.model,
        resolved.account.projectId,
        geminiBody as unknown as Record<string, unknown>,
      )

      const response = await dispatchToCodeAssist({
        accessToken: resolved.accessToken,
        body: wrapped,
        streaming: !!params.stream,
        signal: options?.signal,
      })
      httpResponse = response

      if (!response.ok) {
        throw await buildApiErrorFromResponse(response, resolved)
      }

      // Success path.
      getAntigravityRotation().recordSuccess(resolved.account)

      if (params.stream) {
        if (!response.body) {
          throw APIError.generate(
            500,
            undefined,
            'Antigravity stream returned no body',
            response.headers as unknown as Headers,
          )
        }
        const events = geminiStreamToAnthropicEvents(
          parseCodeAssistSSE(response.body),
          params.model,
        )
        return new AntigravityShimStream(events)
      }

      return await readNonStreaming(response, params.model)
    })()

    ;(promise as unknown as Record<string, unknown>).withResponse = async () => {
      const data = await promise
      return {
        data,
        response: httpResponse ?? new Response(),
        request_id:
          httpResponse?.headers.get('x-request-id') ?? `agent-${randomUUID()}`,
      }
    }

    void self
    return promise
  }
}

class AntigravityShimBeta {
  messages: AntigravityShimMessages
  constructor() {
    this.messages = new AntigravityShimMessages()
  }
}

/**
 * Construct a duck-typed Anthropic-like client backed by Antigravity.
 *
 * The returned object exposes `.beta.messages.create()` and
 * `.messages.create()` so it can stand in wherever the Anthropic SDK
 * client is used.
 *
 * Note: all auth comes from the multi-account store (no header
 * filtering needed — buildApiHeaders sets a fresh Bearer token per
 * request, and we don't accept caller-provided Authorization headers).
 * The `_unused` parameter is kept to mirror createOpenAIShimClient's
 * shape so client.ts can drop us in without rewriting its call site.
 */
export function createAntigravityShimClient(_unused?: {
  defaultHeaders?: Record<string, string>
  maxRetries?: number
  timeout?: number
}): unknown {
  const beta = new AntigravityShimBeta()
  return {
    beta,
    messages: beta.messages,
  }
}

/**
 * Build a header set sufficient for diagnostic onboarding calls (the
 * loadCodeAssist / userinfo discovery already lives in
 * services/oauth/antigravity.ts as `buildApiHeaders`). Re-exported here
 * so the client.ts dispatch can stay self-contained.
 */
export { buildApiHeaders as antigravityOnboardHeaders }
