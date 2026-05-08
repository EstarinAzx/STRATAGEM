/**
 * Antigravity Code Assist envelope wrapper.
 *
 * The Code Assist proxy at cloudcode-pa.googleapis.com expects requests
 * wrapped in an outer envelope that identifies the calling client. The
 * combination of envelope fields + request headers is what routes quota
 * to the Antigravity pool — get any field wrong and the server falls
 * through to the free Code Assist tier (or 403s the call entirely).
 *
 * Envelope shape (matches CLIProxyAPI's geminiToAntigravity):
 *   {
 *     model:       <native model id>,
 *     userAgent:   "antigravity",
 *     requestType: "agent" | "image_gen",
 *     project:     <discovered project id>,
 *     requestId:   "agent-<uuid>" | "image_gen/<ts>/<uuid>/12",
 *     request: {
 *       sessionId, contents, ...generationConfig
 *     }
 *   }
 *
 * This is the trimmed port of Tau's gemini_code_assist.ts — Antigravity
 * executor only, no CLI executor, no cache files (we already store
 * projectId on the AntigravityAccount record), no tier detection.
 */

import { randomUUID } from 'crypto'
import {
  ANTIGRAVITY_API_VERSION,
  buildRequestUrl,
  REQUEST_ENDPOINTS_IN_ORDER,
} from '../oauth/antigravity.js'

// ─── Minimal Gemini response shapes ───────────────────────────────
// These will be tightened by the adapter modules in Phase 2 once
// they import from here. Keeping them lax for now so the wrapper +
// SSE parser don't lock the adapter shape too early.

export interface GeminiUsageMetadata {
  promptTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
  cachedContentTokenCount?: number
  totalTokenCount?: number
}

export interface GeminiCandidate {
  content?: {
    role?: string
    parts?: Array<Record<string, unknown>>
  }
  finishReason?: string
  index?: number
}

export interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[]
  usageMetadata?: GeminiUsageMetadata
  modelVersion?: string
  promptFeedback?: Record<string, unknown>
}

export interface GeminiStreamChunk extends GeminiGenerateContentResponse {}

export interface CodeAssistWrapperBody {
  model: string
  userAgent: 'antigravity'
  requestType: 'agent' | 'image_gen'
  project: string
  requestId: string
  request: Record<string, unknown>
}

// ─── Envelope wrap / unwrap ───────────────────────────────────────

/**
 * Wrap a standard Gemini generateContent body in the Code Assist envelope.
 *
 * Side effects on `innerRequest`:
 *   - Strips `safetySettings` (the Antigravity executor always removes them).
 *   - For Gemini models, strips `generationConfig.maxOutputTokens` (the
 *     server enforces its own cap and returns INVALID_ARGUMENT otherwise).
 *   - For Claude models, applies content fixes: forces functionResponse
 *     parts to role="user" and drops empty thought/thoughtSignature parts.
 *   - Sets `request.sessionId` to a stable hash of the first user message
 *     (matches CLIProxyAPI's generateStableSessionID — needed for dedup).
 */
export function wrapForCodeAssist(
  model: string,
  projectId: string | null,
  innerRequest: Record<string, unknown>,
): CodeAssistWrapperBody {
  const request = { ...innerRequest }
  delete request.safetySettings

  const isClaude = model.includes('claude')
  if (!isClaude) {
    const gc = request.generationConfig as Record<string, unknown> | undefined
    if (gc) {
      delete gc.maxOutputTokens
    }
  } else {
    applyClaudeContentFixes(request)
  }

  request.sessionId = stableSessionId(request)

  return {
    model,
    userAgent: 'antigravity',
    requestType: model.includes('image') ? 'image_gen' : 'agent',
    project: projectId ?? randomProjectId(),
    requestId: model.includes('image')
      ? `image_gen/${Date.now()}/${randomUUID()}/12`
      : `agent-${randomUUID()}`,
    request,
  }
}

/**
 * Unwrap a single non-streaming Code Assist response. The actual Gemini
 * response is nested under `.response`; everything else (request_id,
 * etc.) is metadata we don't surface.
 */
export function unwrapCodeAssistResponse(
  caResponse: unknown,
): GeminiGenerateContentResponse {
  if (!caResponse || typeof caResponse !== 'object') return {}
  const wrapped = caResponse as { response?: GeminiGenerateContentResponse }
  return wrapped.response ?? {}
}

// ─── Headers ──────────────────────────────────────────────────────

/**
 * Headers for Antigravity executor API calls (generateContent /
 * streamGenerateContent). NOT the onboarding headers — those live in
 * services/oauth/antigravity.ts as `buildApiHeaders`.
 *
 * Note: no X-Goog-Api-Client header here. The Antigravity executor
 * relies on body.userAgent for quota routing rather than the header
 * client identity. Adding X-Goog-Api-Client here will route quota to
 * the wrong pool and trip 429s on the second call.
 */
export function antigravityApiHeaders(
  accessToken: string,
): Record<string, string> {
  const os =
    process.platform === 'win32'
      ? 'win32'
      : process.platform === 'darwin'
        ? 'darwin'
        : 'linux'
  const arch =
    process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : 'x86'
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': `antigravity/${ANTIGRAVITY_API_VERSION} ${os}/${arch}`,
    'x-request-source': 'local',
  }
}

// ─── Endpoint helpers ─────────────────────────────────────────────

/**
 * Build the streaming generateContent URL for a given base endpoint.
 * Antigravity uses `:streamGenerateContent?alt=sse` (server-sent events).
 */
export function streamGenerateContentUrl(baseEndpoint: string): string {
  return buildRequestUrl(baseEndpoint, 'streamGenerateContent', true)
}

/** Non-streaming variant for one-shot calls (mostly diagnostics). */
export function generateContentUrl(baseEndpoint: string): string {
  return buildRequestUrl(baseEndpoint, 'generateContent', false)
}

/** Re-export the endpoint fallback chain for convenience. */
export { REQUEST_ENDPOINTS_IN_ORDER }

// ─── SSE parsing ──────────────────────────────────────────────────

/**
 * Parse a Code Assist SSE stream and yield unwrapped Gemini chunks.
 *
 * Each SSE `data:` line is a JSON envelope `{ response: <chunk> }`. We
 * strip the wrapper and yield only the inner Gemini chunk so the
 * downstream Anthropic adapter doesn't have to know about the envelope.
 */
export async function* parseCodeAssistSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<GeminiStreamChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line.startsWith('data: ')) continue
        const jsonStr = line.slice(6)
        if (jsonStr === '[DONE]') return
        try {
          const wrapped = JSON.parse(jsonStr) as {
            response?: GeminiStreamChunk
          }
          if (wrapped.response) {
            yield wrapped.response
          }
        } catch {
          // Malformed chunk — skip and continue.
        }
      }
    }

    // Flush any trailing partial on end-of-stream.
    const tail = buffer.trim()
    if (tail.startsWith('data: ')) {
      const jsonStr = tail.slice(6)
      if (jsonStr && jsonStr !== '[DONE]') {
        try {
          const wrapped = JSON.parse(jsonStr) as {
            response?: GeminiStreamChunk
          }
          if (wrapped.response) {
            yield wrapped.response
          }
        } catch {
          // ignore
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ─── Internals ────────────────────────────────────────────────────

/**
 * Apply Claude-on-Antigravity content fixes in place.
 *
 *   1. Any content whose parts contain a `functionResponse` must have
 *      role="user" — Claude treats tool-result messages as user-role.
 *   2. Pure `{thought: true}` parts with no functionCall are dropped —
 *      Claude rejects empty thought blobs (Gemini 3.x emits them).
 *   3. Parts that carry only a `thoughtSignature` with no functionCall
 *      and no text are dropped for the same reason.
 *
 * Mirrors CLIProxyAPI's antigravity executor transformRequest().
 */
function applyClaudeContentFixes(request: Record<string, unknown>): void {
  const contents = request.contents
  if (!Array.isArray(contents)) return
  for (let i = 0; i < contents.length; i++) {
    const c = contents[i] as
      | { role?: string; parts?: Array<Record<string, unknown>> }
      | null
    if (!c || !Array.isArray(c.parts)) continue
    const hasFunctionResponse = c.parts.some(
      p => p && typeof p === 'object' && 'functionResponse' in p,
    )
    const role = hasFunctionResponse ? 'user' : c.role
    const parts = c.parts.filter(p => {
      if (!p || typeof p !== 'object') return true
      const hasFunctionCall = 'functionCall' in p
      const hasText =
        'text' in p && typeof (p as { text?: unknown }).text === 'string'
      if ('thought' in p && !hasFunctionCall) return false
      if ('thoughtSignature' in p && !hasFunctionCall && !hasText) return false
      return true
    })
    contents[i] = { ...c, role, parts }
  }
}

/**
 * Deterministic session ID derived from the first user message. Same
 * conversation produces the same id, which the Code Assist proxy uses
 * for server-side dedup. Doesn't need to be cryptographic — just
 * stable.
 */
function stableSessionId(request: Record<string, unknown>): string {
  const contents = request.contents as
    | Array<{ role?: string; parts?: Array<{ text?: string }> }>
    | undefined
  if (Array.isArray(contents)) {
    for (const c of contents) {
      if (c.role === 'user' && c.parts?.[0]?.text) {
        let h = 0
        for (const ch of c.parts[0].text) {
          h = ((h << 5) - h + ch.charCodeAt(0)) | 0
        }
        return '-' + Math.abs(h).toString()
      }
    }
  }
  return '-' + Math.floor(Math.random() * 9e18).toString()
}

/** Random project ID fallback — only used when no projectId is on file. */
function randomProjectId(): string {
  const adj = ['useful', 'bright', 'swift', 'calm', 'bold']
  const noun = ['fuze', 'wave', 'spark', 'flow', 'core']
  const a = adj[Math.floor(Math.random() * adj.length)]
  const n = noun[Math.floor(Math.random() * noun.length)]
  const r = randomUUID().slice(0, 5).toLowerCase()
  return `${a}-${n}-${r}`
}
