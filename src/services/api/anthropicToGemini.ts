/**
 * Outbound adapter: Anthropic-format request → Google Gemini generateContent.
 *
 * Gemini uses a different structure:
 *   contents:           [{role: "user"|"model", parts: [...]}]
 *   tools:              [{functionDeclarations: [...]}]
 *   systemInstruction:  {parts: [{text}]}
 *   generationConfig:   {maxOutputTokens, temperature, thinkingConfig, ...}
 *
 * Tool-call reliability is layered defense (in order):
 *   1. SERVER ENFORCEMENT — toolConfig.functionCallingConfig.mode = "VALIDATED"
 *      makes Gemini validate functionCall args server-side before returning
 *      them. Calls with missing required fields are retried internally and
 *      never reach us.
 *   2. SCHEMA SANITIZATION — strip JSON-Schema fields Gemini rejects
 *      ($schema, additionalProperties, ...) and flatten anyOf/oneOf/allOf.
 *   3. TOOL NAME SANITIZATION — prefix digit-leading names with `t_`
 *      (Gemini requires `^[a-zA-Z_]`). Reverse map in the inbound adapter
 *      so the dispatcher still resolves.
 *   4. PER-TOOL HINT — append a compact "STRICT PARAMETERS: ..." line to
 *      each tool's description as a one-glance schema reminder.
 *   5. SYSTEM-INSTRUCTION NUDGE — short reminder block telling the model
 *      to honor the schema instead of training-data memory.
 *   6. SCHEMA CACHE FOR ARG REPAIR — record each parameter shape so the
 *      inbound side can JSON.parse stringly-typed values when the schema
 *      declares array/object.
 *
 * Ported from Tau (MIT). Uses Stratagem's loose ShimCreateParams type
 * rather than introducing a new internal request shape.
 */

import type { ShimCreateParams } from './codexShim.js'
import {
  getThoughtSignature,
  recordToolSchema,
  rememberGeminiToolRename,
  sanitizeGeminiToolName,
} from './geminiAdapterShared.js'

// ─── Gemini types ─────────────────────────────────────────────────

export interface GeminiSafetySettingEntry {
  category: string
  threshold: string
}

export interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export type GeminiPart =
  | { text: string; thought?: boolean }
  | {
      functionCall: {
        id?: string
        name: string
        args: Record<string, unknown>
      }
      thoughtSignature?: string
    }
  | {
      functionResponse: {
        id?: string
        name: string
        response: { content: string }
      }
    }
  | { inlineData: { mimeType: string; data: string } }

export interface GeminiFunctionDeclaration {
  name: string
  description?: string
  parameters: Record<string, unknown>
}

export interface GeminiRequest {
  contents: GeminiContent[]
  tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>
  toolConfig?: {
    functionCallingConfig?: {
      mode?: 'AUTO' | 'ANY' | 'NONE' | 'VALIDATED'
      allowedFunctionNames?: string[]
    }
  }
  systemInstruction?: { parts: Array<{ text: string }> }
  generationConfig?: {
    maxOutputTokens?: number
    temperature?: number
    topP?: number
    topK?: number
    stopSequences?: string[]
    thinkingConfig?: {
      thinkingBudget?: number
      includeThoughts?: boolean
    }
  }
  safetySettings?: GeminiSafetySettingEntry[]
  /**
   * Reference to a previously created `cachedContents/...` resource. When
   * set, `systemInstruction` and `tools` MUST be omitted — the cache
   * carries them. Not currently produced by this adapter; reserved for
   * future cachedContent wiring.
   */
  cachedContent?: string
}

// ─── Synthetic thought signature ──────────────────────────────────
// Sentinel value Gemini accepts to bypass strict signature validation.
// Used when no real signature is available (e.g. first turn of a session).
const SYNTHETIC_THOUGHT_SIGNATURE = 'skip_thought_signature_validator'

// ─── Safety settings ──────────────────────────────────────────────
// Mirrors CLIProxyAPI's DefaultSafetySettings — all harm categories OFF
// so Gemini doesn't block legitimate code content (shell commands,
// security tools, error handling). Disable with GEMINI_SAFETY=default.

function getGeminiSafetySettings(): GeminiSafetySettingEntry[] | undefined {
  if (process.env.GEMINI_SAFETY === 'default') return undefined
  return [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
  ]
}

// ─── Generation config defaults ───────────────────────────────────
//
// Claude's secret: `type: 'adaptive'` — no fixed thinking budget. The
// model decides per-turn how much to think. Gemini's equivalent is
// `thinkingBudget: -1` (dynamic mode). Same concept, same benefit.
//
// All values overridable via env:
//   GEMINI_TOP_P        — sampling (default 0.95)
//   GEMINI_TOP_K        — sampling (default 64)
//   GEMINI_THINKING     — thinking budget (0=off, -1=dynamic, N=fixed)
//   GEMINI_TEMPERATURE  — temperature override

function envFloat(key: string): number | undefined {
  const v = process.env[key]
  if (!v) return undefined
  const n = parseFloat(v)
  return isNaN(n) ? undefined : n
}

function envInt(key: string): number | undefined {
  const v = process.env[key]
  if (!v) return undefined
  const n = parseInt(v, 10)
  return isNaN(n) ? undefined : n
}

function modelSupportsDynamicThinking(model: string): boolean {
  const m = model.toLowerCase()
  if (!m.startsWith('gemini-')) return false
  if (m.includes('lite')) return false
  if (
    m.includes('gemini-2.5') ||
    m.includes('gemini-3') ||
    m.includes('gemini-4')
  ) {
    return true
  }
  return false
}

function getModelGenerationDefaults(model: string): {
  topP: number
  topK: number
  temperature: number | undefined
  supportsDynamicThinking: boolean
} {
  return {
    topP: envFloat('GEMINI_TOP_P') ?? 0.95,
    topK: envInt('GEMINI_TOP_K') ?? 64,
    temperature: envFloat('GEMINI_TEMPERATURE'),
    supportsDynamicThinking: modelSupportsDynamicThinking(model),
  }
}

// ─── Schema sanitization ─────────────────────────────────────────

const UNSUPPORTED_GEMINI_SCHEMA_FIELDS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$comment',
  '$defs',
  'definitions',
  'not',
  'if',
  'then',
  'else',
  'additionalProperties',
  'patternProperties',
  'propertyNames',
  'minProperties',
  'maxProperties',
  'unevaluatedProperties',
  'dependentRequired',
  'dependentSchemas',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'pattern',
  'contentMediaType',
  'contentEncoding',
  'unevaluatedItems',
  'prefixItems',
  'contains',
  'minContains',
  'maxContains',
  'default',
  'const',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
  'title',
])

/**
 * Flatten JSON Schema composition keywords (anyOf/oneOf/allOf) before the
 * normal sanitize pass. Strategy:
 *   - anyOf / oneOf with a null type → extract non-null branch + nullable
 *   - anyOf / oneOf without null     → take the first branch
 *   - allOf                          → shallow-merge all branches
 */
function flattenComposition(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...schema }

  // type: ["string", "null"] → type: "string", nullable: true
  if (Array.isArray(result.type)) {
    const types = result.type as string[]
    const nonNull = types.filter(t => t !== 'null')
    if (types.includes('null')) {
      result.nullable = true
    }
    result.type = nonNull.length === 1 ? nonNull[0] : (nonNull[0] ?? 'string')
  }

  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const variants = result[keyword] as Record<string, unknown>[] | undefined
    if (!Array.isArray(variants) || variants.length === 0) continue

    const nonNull = variants.filter(v => v.type !== 'null')
    const hasNull = variants.some(v => v.type === 'null')
    const picked = nonNull[0] ?? variants[0]!

    delete result[keyword]
    if (hasNull) result.nullable = true
    for (const [k, v] of Object.entries(picked)) {
      if (v !== undefined && !(k in result && k !== keyword)) {
        result[k] = v
      }
    }
  }

  if (Array.isArray(result.allOf)) {
    const branches = result.allOf as Record<string, unknown>[]
    delete result.allOf
    for (const branch of branches) {
      for (const [k, v] of Object.entries(branch)) {
        if (v === undefined) continue
        if (k === 'properties' && result.properties) {
          result.properties = {
            ...(result.properties as Record<string, unknown>),
            ...(v as Record<string, unknown>),
          }
        } else if (k === 'required' && result.required) {
          result.required = [
            ...new Set([
              ...(result.required as string[]),
              ...(v as string[]),
            ]),
          ]
        } else if (!(k in result)) {
          result[k] = v
        }
      }
    }
  }

  return result
}

/**
 * Recursively strip fields Gemini doesn't support from a JSON Schema.
 * Returns a new object — does not mutate the original.
 */
export function sanitizeSchemaForGemini(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const flattened = flattenComposition(schema)
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(flattened)) {
    if (UNSUPPORTED_GEMINI_SCHEMA_FIELDS.has(key)) continue
    if (value === undefined) continue

    if (
      key === 'properties' &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      result[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .map(([propName, propSchema]) => [
            propName,
            propSchema &&
            typeof propSchema === 'object' &&
            !Array.isArray(propSchema)
              ? sanitizeSchemaForGemini(propSchema as Record<string, unknown>)
              : propSchema,
          ]),
      )
    } else if (
      key === 'items' &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      result[key] = sanitizeSchemaForGemini(value as Record<string, unknown>)
    } else if (key === 'required' && Array.isArray(value)) {
      // Gemini rejects empty required arrays
      if (value.length > 0) result[key] = value
    } else if (Array.isArray(value)) {
      result[key] = value.map(item =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? sanitizeSchemaForGemini(item as Record<string, unknown>)
          : item,
      )
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = sanitizeSchemaForGemini(value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }

  return result
}

// ─── Tool schema augmentation ────────────────────────────────────

/**
 * Compact reminder prepended to systemInstruction whenever tools are
 * present. Backstops the server-side `mode: "VALIDATED"` enforcement
 * by nudging the model to emit valid calls on the first try.
 *
 * Kept short (~10 lines): every byte here is on every Gemini turn and
 * the previous 50-line version measurably hurt latency on flash-lite.
 */
const GEMINI_TOOL_SCHEMA_SYSTEM_INSTRUCTION = `<TOOL_USAGE_RULES>
Tool schemas in this environment OVERRIDE your training-data memory of tool names.
Treat each tool's "parameters" field as authoritative:
- Use parameter NAMES exactly as listed in "properties" (case-sensitive).
- Supply EVERY parameter listed in "required" — never omit one, never send empty objects.
- Match parameter TYPES exactly (array means array, object means object, string means string).
- Do not invent extra parameters that are not in "properties".
The "STRICT PARAMETERS:" hint at the end of each tool description is your quick reference.
</TOOL_USAGE_RULES>
`

function normalizeSchemaTypeForSummary(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const nonNull = value.filter(t => t !== 'null')
    const first = nonNull[0] ?? value[0]
    if (typeof first === 'string') return first
  }
  return undefined
}

function summarizeSchemaNode(schema: unknown, depth: number): string {
  if (!schema || typeof schema !== 'object') return 'unknown'

  const record = schema as Record<string, unknown>
  const typeStr = normalizeSchemaTypeForSummary(record.type)
  const enumValues = Array.isArray(record.enum)
    ? (record.enum as unknown[])
    : undefined

  if (typeStr === 'array') {
    const itemSummary =
      depth > 0 ? summarizeSchemaNode(record.items, depth - 1) : 'unknown'
    return `array[${itemSummary}]`
  }

  if (typeStr === 'object') {
    const props = record.properties as Record<string, unknown> | undefined
    const required = Array.isArray(record.required)
      ? (record.required as unknown[]).filter(
          (v): v is string => typeof v === 'string',
        )
      : []

    if (!props || depth <= 0) return 'object'

    const keys = Object.keys(props)
    const requiredKeys = keys.filter(k => required.includes(k))
    const optionalKeys = keys.filter(k => !required.includes(k))
    const ordered = [...requiredKeys.sort(), ...optionalKeys.sort()]
    const max = 8
    const shown = ordered.slice(0, max)

    const inner = shown
      .map(k => {
        const sub = summarizeSchemaNode(props[k], depth - 1)
        return `${k}: ${sub}${required.includes(k) ? ' REQUIRED' : ''}`
      })
      .join(', ')

    const extra = ordered.length - shown.length
    const more = extra > 0 ? `, …+${extra}` : ''
    return `{${inner}${more}}`
  }

  if (enumValues && enumValues.length > 0) {
    const preview = enumValues.slice(0, 6).map(String).join('|')
    const suffix = enumValues.length > 6 ? '|…' : ''
    return `${typeStr ?? 'unknown'} enum(${preview}${suffix})`
  }

  return typeStr ?? 'unknown'
}

export function buildStrictParamsSummary(
  parameters: Record<string, unknown>,
): string {
  const typeStr = normalizeSchemaTypeForSummary(parameters.type)
  const properties = parameters.properties as
    | Record<string, unknown>
    | undefined
  const required = Array.isArray(parameters.required)
    ? (parameters.required as unknown[]).filter(
        (v): v is string => typeof v === 'string',
      )
    : []

  if (typeStr !== 'object' || !properties) {
    return '(schema missing top-level object properties)'
  }

  const keys = Object.keys(properties)
  const requiredKeys = keys.filter(k => required.includes(k))
  const optionalKeys = keys.filter(k => !required.includes(k))
  const ordered = [...requiredKeys.sort(), ...optionalKeys.sort()]

  const summary = ordered
    .map(k => {
      const sub = summarizeSchemaNode(properties[k], 2)
      return `${k}: ${sub}${required.includes(k) ? ' REQUIRED' : ''}`
    })
    .join(', ')

  const max = 900
  return summary.length > max ? `${summary.slice(0, max)}…` : summary
}

function appendStrictParamsToDescription(
  description: string | undefined,
  parameters: Record<string, unknown>,
): string {
  const summary = buildStrictParamsSummary(parameters)
  const base = (description ?? '').trim()
  if (base.includes('STRICT PARAMETERS:')) return description ?? ''
  return base.length > 0
    ? `${base}\n\nSTRICT PARAMETERS: ${summary}`
    : `STRICT PARAMETERS: ${summary}`
}

// ─── Loose Anthropic shape (as it appears in ShimCreateParams) ───
// These mirror what arrives in shim params from claude.ts. We don't
// import Anthropic SDK types to avoid coupling — the wire layer
// validates structural fields before calling the adapter.

interface AnthropicSystemBlock {
  type?: 'text'
  text?: string
  cache_control?: unknown
}

interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

// ─── Conversion ───────────────────────────────────────────────────

export function anthropicToGeminiRequest(
  params: ShimCreateParams,
): GeminiRequest {
  const model = params.model

  // Per-request map: tool_use_id → tool_name. Gemini's functionResponse
  // is keyed by function name, not the original Anthropic tool id.
  const toolIdToName = new Map<string, string>()

  const request: GeminiRequest = {
    contents: convertMessages(
      (params.messages ?? []) as Array<Record<string, unknown>>,
      toolIdToName,
    ),
  }

  // System prompt → systemInstruction (strip cache_control)
  if (params.system) {
    let systemText = ''
    if (typeof params.system === 'string') {
      systemText = params.system
    } else if (Array.isArray(params.system)) {
      systemText = (params.system as AnthropicSystemBlock[])
        .map(s => s.text ?? '')
        .filter(Boolean)
        .join('\n\n')
    }
    if (systemText) {
      request.systemInstruction = { parts: [{ text: systemText }] }
    }
  }

  // Tools → functionDeclarations (sanitize schemas)
  if (Array.isArray(params.tools) && params.tools.length > 0) {
    const tools = params.tools as unknown as AnthropicTool[]
    request.tools = [
      {
        functionDeclarations: tools.map(t => {
          const sanitizedName = sanitizeGeminiToolName(t.name)
          rememberGeminiToolRename(t.name, sanitizedName)
          const parameters = sanitizeSchemaForGemini(t.input_schema)
          recordToolSchema(t.name, parameters)
          if (sanitizedName !== t.name) {
            recordToolSchema(sanitizedName, parameters)
          }
          return {
            name: sanitizedName,
            description: appendStrictParamsToDescription(
              t.description,
              parameters,
            ),
            parameters,
          }
        }),
      },
    ]

    // Server-side schema enforcement.
    request.toolConfig = {
      functionCallingConfig: { mode: 'VALIDATED' },
    }

    // Backstop nudge.
    const existingText = request.systemInstruction?.parts?.[0]?.text ?? ''
    if (!existingText.includes('<TOOL_USAGE_RULES>')) {
      const merged = existingText
        ? `${GEMINI_TOOL_SCHEMA_SYSTEM_INSTRUCTION}\n${existingText}`
        : GEMINI_TOOL_SCHEMA_SYSTEM_INSTRUCTION
      request.systemInstruction = { parts: [{ text: merged }] }
    }
  }

  // Safety settings — env override or all-OFF default.
  const safety = getGeminiSafetySettings()
  if (safety) request.safetySettings = safety

  // Generation config — model defaults + env overrides + Anthropic params.
  const defaults = getModelGenerationDefaults(model)
  request.generationConfig = {
    maxOutputTokens: typeof params.max_tokens === 'number'
      ? params.max_tokens
      : undefined,
    temperature:
      defaults.temperature ??
      (typeof params.temperature === 'number' ? params.temperature : 1),
    topP: defaults.topP,
    topK: defaults.topK,
    ...(Array.isArray(params.stop_sequences) && {
      stopSequences: params.stop_sequences as string[],
    }),
  }

  // Thinking config — adaptive (-1) by default for Gemini 2.5+/3.x/4.x.
  const envThinking = envInt('GEMINI_THINKING')
  const thinkingParam = (params as { thinking?: { type?: string } }).thinking
  if (envThinking !== undefined) {
    if (envThinking !== 0) {
      request.generationConfig.thinkingConfig = {
        thinkingBudget: envThinking,
        includeThoughts: true,
      }
    }
  } else if (thinkingParam?.type === 'disabled') {
    // explicit off — respect it
  } else if (defaults.supportsDynamicThinking) {
    request.generationConfig.thinkingConfig = {
      thinkingBudget: -1,
      includeThoughts: true,
    }
  }

  return request
}

// ─── Message conversion ──────────────────────────────────────────

interface AnthropicMessageLoose {
  role: string
  content:
    | string
    | Array<Record<string, unknown>>
}

interface AnthropicTextBlock {
  type: 'text'
  text: string
}

interface AnthropicToolUseBlock {
  type: 'tool_use'
  id?: string
  name?: string
  input?: Record<string, unknown>
  _gemini_thought_signature?: string
}

interface AnthropicThinkingBlock {
  type: 'thinking'
  thinking?: string
}

interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id?: string
  content?:
    | string
    | Array<{ text?: string }>
}

interface AnthropicImageBlock {
  type: 'image'
  source?: { media_type: string; data: string }
}

type AnthropicBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock
  | { type: 'redacted_thinking' }
  | AnthropicToolResultBlock
  | AnthropicImageBlock

function convertMessages(
  messages: Array<Record<string, unknown>>,
  toolIdToName: Map<string, string>,
): GeminiContent[] {
  const result: GeminiContent[] = []

  for (const rawMsg of messages) {
    const msg = rawMsg as unknown as AnthropicMessageLoose
    const geminiRole: 'user' | 'model' =
      msg.role === 'assistant' ? 'model' : 'user'

    if (typeof msg.content === 'string') {
      // Merge consecutive same-role messages (Gemini requires alternating).
      const last = result[result.length - 1]
      if (last && last.role === geminiRole) {
        last.parts.push({ text: msg.content })
      } else {
        result.push({ role: geminiRole, parts: [{ text: msg.content }] })
      }
      continue
    }

    const blocks = msg.content as AnthropicBlock[]
    const parts: GeminiPart[] = []

    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          if (block.text) parts.push({ text: block.text })
          break

        case 'tool_use': {
          if (block.id && block.name) {
            toolIdToName.set(block.id, block.name)
          }
          // thoughtSignature must be present on every functionCall in
          // history for Gemini 2.5+/3.x thinking models. Priority:
          // real signature on the block → session cache → synthetic.
          const sig =
            block._gemini_thought_signature ??
            getThoughtSignature(block.id ?? '') ??
            SYNTHETIC_THOUGHT_SIGNATURE
          // Carry the Anthropic id on functionCall.id so Antigravity's
          // proxy can populate `tool_use.id` when it converts to Claude
          // format — Claude rejects with "tool_use.id: Field required"
          // otherwise.
          const fcPart: Record<string, unknown> = {
            functionCall: {
              ...(block.id ? { id: block.id } : {}),
              name: block.name ?? '',
              args: (block.input as Record<string, unknown>) ?? {},
            },
            thoughtSignature: sig,
          }
          parts.push(fcPart as GeminiPart)
          break
        }

        case 'thinking':
          if (block.thinking) {
            parts.push({ text: block.thinking, thought: true })
          }
          break

        case 'redacted_thinking':
          // Anthropic redacted thinking — not applicable to Gemini, skip.
          break

        case 'tool_result': {
          const funcName = block.tool_use_id
            ? (toolIdToName.get(block.tool_use_id) ?? block.tool_use_id)
            : 'unknown'
          const content =
            typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map(c => c.text ?? '').join('')
                : ''
          parts.push({
            functionResponse: {
              ...(block.tool_use_id ? { id: block.tool_use_id } : {}),
              name: funcName,
              response: { content },
            },
          } as GeminiPart)
          break
        }

        case 'image':
          if (block.source) {
            parts.push({
              inlineData: {
                mimeType: block.source.media_type,
                data: block.source.data,
              },
            })
          }
          break
      }
    }

    if (parts.length === 0) continue

    const last = result[result.length - 1]
    if (last && last.role === geminiRole) {
      last.parts.push(...parts)
    } else {
      result.push({ role: geminiRole, parts })
    }
  }

  return result
}
