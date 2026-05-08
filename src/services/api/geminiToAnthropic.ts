/**
 * Inbound adapter: Gemini streaming response → Anthropic stream events.
 *
 * Each Gemini chunk has `candidates[].content.parts[]` with text /
 * thought / functionCall payloads. We emit the standard Anthropic
 * sequence so the rest of the streaming pipeline doesn't know it's
 * talking to Gemini:
 *
 *   message_start
 *     → content_block_start (text | thinking | tool_use)
 *     → content_block_delta*
 *     → content_block_stop
 *   message_delta (final stop_reason + usage)
 *   message_stop
 *
 * Thought signatures from functionCall parts are stashed in the session
 * cache so the same call can be replayed in conversation history (the
 * outbound adapter requires them on every functionCall in history).
 *
 * Ported from Tau (MIT). Uses Stratagem's loose AnthropicStreamEvent
 * type rather than introducing a stricter internal shape.
 */

import type {
  AnthropicStreamEvent,
  AnthropicUsage,
} from './codexShim.js'
import {
  coerceToolCallArgs,
  originalToolNameFromGemini,
  storeThoughtSignature,
} from './geminiAdapterShared.js'

// ─── Gemini response shapes ──────────────────────────────────────

export interface GeminiStreamChunk {
  candidates?: Array<{
    content?: {
      role?: string
      parts?: Array<{
        text?: string
        thought?: boolean
        functionCall?: {
          id?: string
          name: string
          args: Record<string, unknown>
        }
        thoughtSignature?: string
      }>
    }
    finishReason?: string
    safetyRatings?: Array<{ category: string; probability: string }>
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
    /**
     * Subset of promptTokenCount served from a cachedContents reference.
     * Maps onto Anthropic's cache_read_input_tokens.
     */
    cachedContentTokenCount?: number
  }
  modelVersion?: string
}

export interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      role?: string
      parts?: Array<{
        text?: string
        thought?: boolean
        functionCall?: {
          id?: string
          name: string
          args: Record<string, unknown>
        }
        thoughtSignature?: string
      }>
    }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
    cachedContentTokenCount?: number
  }
}

// ─── Anthropic message shape (loose, matches what claude.ts expects) ──

export interface AnthropicContentBlock {
  type: 'text' | 'thinking' | 'tool_use'
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  _gemini_thought_signature?: string
}

export interface AnthropicMessage {
  id: string
  type: 'message'
  role: 'assistant'
  content: AnthropicContentBlock[]
  model: string
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null
  stop_sequence: string | null
  usage: Partial<AnthropicUsage> & {
    input_tokens: number
    output_tokens: number
  }
}

// ─── Non-streaming conversion ────────────────────────────────────

export function geminiMessageToAnthropic(
  response: GeminiGenerateContentResponse,
  model: string,
): AnthropicMessage {
  const content: AnthropicContentBlock[] = []
  const candidate = response.candidates?.[0]

  if (candidate?.content?.parts) {
    for (const part of candidate.content.parts) {
      if (part.text) {
        if (part.thought) {
          content.push({ type: 'thinking', thinking: part.text })
        } else {
          content.push({ type: 'text', text: part.text })
        }
      }
      if (part.functionCall) {
        const toolId =
          part.functionCall.id ??
          `toolu_${Math.random().toString(36).slice(2, 14)}`
        const toolName = originalToolNameFromGemini(part.functionCall.name)
        const block: AnthropicContentBlock = {
          type: 'tool_use',
          id: toolId,
          name: toolName,
          input:
            (coerceToolCallArgs(toolName, part.functionCall.args ?? {}) as
              | Record<string, unknown>
              | undefined) ?? {},
        }
        if (part.thoughtSignature) {
          block._gemini_thought_signature = part.thoughtSignature
          storeThoughtSignature(toolId, part.thoughtSignature)
        }
        content.push(block)
      }
    }
  }

  const finishReason = candidate?.finishReason
  const stopReason: AnthropicMessage['stop_reason'] =
    finishReason === 'MAX_TOKENS'
      ? 'max_tokens'
      : content.some(c => c.type === 'tool_use')
        ? 'tool_use'
        : 'end_turn'

  const cachedTokens = response.usageMetadata?.cachedContentTokenCount
  return {
    id: `msg_gemini_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: response.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      ...(cachedTokens !== undefined && cachedTokens > 0
        ? {
            cache_read_input_tokens: cachedTokens,
            cache_creation_input_tokens: 0,
          }
        : {}),
    },
  }
}

// ─── Streaming conversion ────────────────────────────────────────

export async function* geminiStreamToAnthropicEvents(
  geminiStream: AsyncIterable<GeminiStreamChunk>,
  model: string,
): AsyncGenerator<AnthropicStreamEvent> {
  let messageStarted = false
  let blockIndex = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0

  let textBlockOpen = false
  let thinkingBlockOpen = false
  let hasToolUse = false

  for await (const chunk of geminiStream) {
    if (chunk.usageMetadata) {
      inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens
      outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens
      if (chunk.usageMetadata.cachedContentTokenCount !== undefined) {
        cacheReadTokens = chunk.usageMetadata.cachedContentTokenCount
      }
    }

    const candidate = chunk.candidates?.[0]
    if (!candidate?.content?.parts && !candidate?.finishReason) continue

    if (!messageStarted) {
      messageStarted = true
      yield {
        type: 'message_start',
        message: {
          id: `msg_gemini_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: inputTokens,
            output_tokens: 0,
            ...(cacheReadTokens > 0
              ? {
                  cache_read_input_tokens: cacheReadTokens,
                  cache_creation_input_tokens: 0,
                }
              : {}),
          },
        },
      }
    }

    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.text !== undefined) {
          if (part.thought) {
            // Thinking text — close regular text block if open.
            if (textBlockOpen) {
              yield { type: 'content_block_stop', index: blockIndex }
              blockIndex++
              textBlockOpen = false
            }
            if (!thinkingBlockOpen) {
              thinkingBlockOpen = true
              yield {
                type: 'content_block_start',
                index: blockIndex,
                content_block: { type: 'thinking', thinking: '' },
              }
            }
            yield {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'thinking_delta', thinking: part.text },
            }
          } else {
            // Regular text — close thinking block if open.
            if (thinkingBlockOpen) {
              yield { type: 'content_block_stop', index: blockIndex }
              blockIndex++
              thinkingBlockOpen = false
            }
            if (!textBlockOpen) {
              textBlockOpen = true
              yield {
                type: 'content_block_start',
                index: blockIndex,
                content_block: { type: 'text', text: '' },
              }
            }
            yield {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'text_delta', text: part.text },
            }
          }
        }

        if (part.functionCall) {
          if (thinkingBlockOpen) {
            yield { type: 'content_block_stop', index: blockIndex }
            blockIndex++
            thinkingBlockOpen = false
          }
          if (textBlockOpen) {
            yield { type: 'content_block_stop', index: blockIndex }
            blockIndex++
            textBlockOpen = false
          }

          hasToolUse = true
          const toolId =
            part.functionCall.id ??
            `toolu_${Math.random().toString(36).slice(2, 14)}`
          const currentIndex = blockIndex++
          const toolName = originalToolNameFromGemini(part.functionCall.name)

          const contentBlock: AnthropicContentBlock = {
            type: 'tool_use',
            id: toolId,
            name: toolName,
            input: {},
          }
          if (part.thoughtSignature) {
            contentBlock._gemini_thought_signature = part.thoughtSignature
            storeThoughtSignature(toolId, part.thoughtSignature)
          }

          yield {
            type: 'content_block_start',
            index: currentIndex,
            content_block: contentBlock as unknown as Record<string, unknown>,
          }

          // Emit args as a single JSON delta, repairing stringly-typed
          // array/object values via the schema cache.
          const rawArgs = part.functionCall.args ?? {}
          const repairedArgs = coerceToolCallArgs(toolName, rawArgs) ?? rawArgs
          const argsJson = JSON.stringify(repairedArgs)
          yield {
            type: 'content_block_delta',
            index: currentIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: argsJson,
            },
          }

          yield { type: 'content_block_stop', index: currentIndex }
        }
      }
    }

    if (candidate?.finishReason) {
      if (thinkingBlockOpen) {
        yield { type: 'content_block_stop', index: blockIndex }
        thinkingBlockOpen = false
      }
      if (textBlockOpen) {
        yield { type: 'content_block_stop', index: blockIndex }
        textBlockOpen = false
      }

      const finishReason = candidate.finishReason
      const stopReason =
        finishReason === 'MAX_TOKENS'
          ? 'max_tokens'
          : hasToolUse
            ? 'tool_use'
            : 'end_turn'

      yield {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      }

      yield { type: 'message_stop' }
      return
    }
  }

  // Stream ended without finishReason — close gracefully.
  if (messageStarted) {
    if (thinkingBlockOpen) {
      yield { type: 'content_block_stop', index: blockIndex }
    }
    if (textBlockOpen) {
      yield { type: 'content_block_stop', index: blockIndex }
    }
    yield {
      type: 'message_delta',
      delta: {
        stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage: { output_tokens: outputTokens },
    }
    yield { type: 'message_stop' }
  }
}

// ─── Plain-Gemini SSE parser ─────────────────────────────────────
// (Used for the public Gemini API. Antigravity callers should use
//  parseCodeAssistSSE from antigravityCodeAssist.ts since the Code
//  Assist envelope wraps each chunk in `{response: ...}`.)

export async function* parseGeminiSSE(
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

      const segments = buffer.split('\n\n')
      buffer = segments.pop() ?? ''

      for (const segment of segments) {
        for (const rawLine of segment.split('\n')) {
          const line = rawLine.trim()
          if (!line.startsWith('data: ')) continue

          const jsonStr = line.slice(6)
          if (jsonStr === '[DONE]') return

          try {
            yield JSON.parse(jsonStr) as GeminiStreamChunk
          } catch {
            // Malformed JSON in a complete SSE event — skip it.
          }
        }
      }
    }

    if (buffer.trim()) {
      for (const rawLine of buffer.split('\n')) {
        const line = rawLine.trim()
        if (!line.startsWith('data: ')) continue
        const jsonStr = line.slice(6)
        if (jsonStr === '[DONE]') return
        try {
          yield JSON.parse(jsonStr) as GeminiStreamChunk
        } catch {
          // ignore
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
