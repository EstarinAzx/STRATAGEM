/**
 * Session-scoped caches shared by the Anthropic ⇄ Gemini adapters.
 *
 * 1. Thought-signature cache — Gemini 2.5+/3.x thinking models include a
 *    `thought_signature` on every functionCall. The same signature must
 *    appear on the call when it's replayed in conversation history or
 *    Gemini rejects the request. The Stratagem message pipeline strips
 *    custom fields from content blocks during normalization, so we cache
 *    signatures here keyed by tool_use_id to guarantee they survive the
 *    round-trip.
 *
 * 2. Tool-schema cache — Gemini occasionally stringifies structured args
 *    (sends a JSON-encoded string for a parameter the schema declares as
 *    `array` or `object`). The cache records each parameter's expected
 *    type at outbound time so the inbound adapter can JSON.parse those
 *    values back into structured form when needed.
 *
 * 3. Tool-name rename map — Gemini requires function names to match
 *    `^[a-zA-Z_]`. Names that start with a digit (some MCP conventions)
 *    are prefixed `t_` on the way out; this map reverses the rename when
 *    a functionCall comes back so the tool dispatcher still resolves.
 *
 * Ported from Tau (MIT) — collapsed three small files into one.
 */

// ─── Thought-signature cache ─────────────────────────────────────

const _signatures = new Map<string, string>()

export function storeThoughtSignature(
  toolUseId: string,
  signature: string,
): void {
  _signatures.set(toolUseId, signature)
}

export function getThoughtSignature(toolUseId: string): string | undefined {
  return _signatures.get(toolUseId)
}

// ─── Tool-name rename map ────────────────────────────────────────

/**
 * Gemini requires function names to match `^[a-zA-Z_][a-zA-Z0-9_-]*$`.
 * Names that start with a digit get a `t_` prefix; the same prefix is
 * reversed when names come back so the tool dispatcher still resolves.
 */
export function sanitizeGeminiToolName(name: string): string {
  if (!name) return name
  return /^[0-9]/.test(name) ? `t_${name}` : name
}

const renamedToolMap = new Map<string, string>()

/** Records a tool name remapping so inbound responses can reverse it. */
export function rememberGeminiToolRename(
  original: string,
  sanitized: string,
): void {
  if (original !== sanitized) renamedToolMap.set(sanitized, original)
}

/** Reverses sanitizeGeminiToolName for inbound functionCall.name values. */
export function originalToolNameFromGemini(name: string): string {
  return renamedToolMap.get(name) ?? name
}

// ─── Tool-schema cache ───────────────────────────────────────────

export interface SchemaInfo {
  type: string
  items?: SchemaInfo
  properties?: Record<string, SchemaInfo>
}

const cache = new Map<string, Map<string, SchemaInfo>>()

function normalizeType(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const nonNull = value.filter(t => t !== 'null')
    const first = nonNull[0] ?? value[0]
    if (typeof first === 'string') return first
  }
  return 'unknown'
}

function extract(schema: unknown): SchemaInfo {
  if (!schema || typeof schema !== 'object') return { type: 'unknown' }
  const record = schema as Record<string, unknown>
  const type = normalizeType(record.type)
  const info: SchemaInfo = { type }

  if (type === 'array' && record.items) {
    info.items = extract(record.items)
  } else if (
    type === 'object' &&
    record.properties &&
    typeof record.properties === 'object'
  ) {
    info.properties = {}
    for (const [key, value] of Object.entries(
      record.properties as Record<string, unknown>,
    )) {
      info.properties[key] = extract(value)
    }
  }

  return info
}

/**
 * Records the parameter shape for a tool, keyed by name. Pass the JSON
 * Schema object that has `properties`. Stores nothing for tools without
 * properties but still records the name so repeated calls don't surprise
 * the caller.
 */
export function recordToolSchema(toolName: string, schema: unknown): void {
  if (!toolName) return
  const properties =
    schema && typeof schema === 'object'
      ? (schema as Record<string, unknown>).properties
      : undefined

  const params = new Map<string, SchemaInfo>()
  if (
    properties &&
    typeof properties === 'object' &&
    !Array.isArray(properties)
  ) {
    for (const [name, paramSchema] of Object.entries(
      properties as Record<string, unknown>,
    )) {
      params.set(name, extract(paramSchema))
    }
  }
  cache.set(toolName, params)
}

/** Returns the recorded type for a single parameter (e.g. "array"). */
export function getParamType(
  toolName: string,
  paramName: string,
): string | undefined {
  return cache.get(toolName)?.get(paramName)?.type
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 2) return false
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  return (first === '{' && last === '}') || (first === '[' && last === ']')
}

/**
 * Walks a tool-call args object and JSON-parses string values whose schema
 * declares them as `array` or `object`. Leaves everything else untouched.
 * Returns the original reference when no coercion was needed.
 */
export function coerceToolCallArgs(toolName: string, args: unknown): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args
  const params = cache.get(toolName)
  if (!params || params.size === 0) return args

  const record = args as Record<string, unknown>
  let mutated = false
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    const expected = params.get(key)?.type
    if (
      typeof value === 'string' &&
      (expected === 'array' || expected === 'object') &&
      looksLikeJson(value)
    ) {
      try {
        next[key] = JSON.parse(value)
        mutated = true
        continue
      } catch {
        // fall through and keep the original string
      }
    }
    next[key] = value
  }

  return mutated ? next : args
}

/** Test-only / shutdown helper. */
export function clearGeminiAdapterCaches(): void {
  cache.clear()
  _signatures.clear()
  renamedToolMap.clear()
}
