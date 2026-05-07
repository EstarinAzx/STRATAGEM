import { z } from 'zod/v4'
import {
  AUTO_MEM_KNOWLEDGE_CATEGORIES,
  getAutoMemPath,
} from '../../memdir/paths.js'
import {
  rankMemoriesForQuery,
} from '../../memdir/findRelevantMemories.js'
import {
  formatMemoryManifest,
  type MemoryHeader,
  scanMemoryFiles,
} from '../../memdir/memoryScan.js'
import { MEMORY_TYPES } from '../../memdir/memoryTypes.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  buildMemoryListPrompt,
  isAutoMemoryEnabled,
  MEMORY_LIST_DESCRIPTION,
  MEMORY_LIST_TOOL_NAME,
} from './prompt.js'
import { renderListResultMessage, renderListToolUseMessage } from './UI.js'

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 200

const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z
      .string()
      .optional()
      .describe(
        'Optional keyword search. Same ranker as the auto-recall path. When omitted, returns memories sorted newest-first.',
      ),
    type: z
      .enum([...MEMORY_TYPES])
      .optional()
      .describe('Optional filter by memory type.'),
    category: z
      .enum([...AUTO_MEM_KNOWLEDGE_CATEGORIES])
      .optional()
      .describe('Optional filter by knowledge category.'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Maximum memories to return. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    memories: z.array(
      z.object({
        relativePath: z.string(),
        type: z.string().nullable(),
        category: z.string().nullable(),
        description: z.string().nullable(),
        mtimeMs: z.number(),
      }),
    ),
    total: z.number(),
    truncated: z.boolean(),
    manifest: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type ListOutput = z.infer<OutputSchema>

export const MemoryListTool = buildTool({
  name: MEMORY_LIST_TOOL_NAME,
  searchHint: 'list or search durable memories',
  maxResultSizeChars: 50_000,
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isAutoMemoryEnabled()
  },
  toAutoClassifierInput(input) {
    return [input.query, input.type, input.category].filter(Boolean).join(' ')
  },
  async description() {
    return MEMORY_LIST_DESCRIPTION
  },
  async prompt() {
    return buildMemoryListPrompt()
  },
  async call({ query, type, category, limit }, { abortController }) {
    const effectiveLimit = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT)
    const memDir = getAutoMemPath()
    const all = await scanMemoryFiles(memDir, abortController.signal)

    let filtered: MemoryHeader[] = all
    if (type) filtered = filtered.filter(m => m.type === type)
    if (category) filtered = filtered.filter(m => m.category === category)

    const ordered = query ? rankMemoriesForQuery(query, filtered) : filtered
    const total = ordered.length
    const truncated = total > effectiveLimit
    const sliced = ordered.slice(0, effectiveLimit)

    return {
      data: {
        memories: sliced.map(m => ({
          relativePath: m.filename,
          type: m.type ?? null,
          category: m.category ?? null,
          description: m.description,
          mtimeMs: m.mtimeMs,
        })),
        total,
        truncated,
        manifest: formatMemoryManifest(sliced),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    if (output.memories.length === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: 'No memories matched.',
      }
    }
    const note = output.truncated
      ? `\n(${output.total - output.memories.length} more — narrow filters or raise \`limit\`.)`
      : ''
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.manifest + note,
    }
  },
  renderToolUseMessage: renderListToolUseMessage,
  renderToolResultMessage: renderListResultMessage,
} satisfies ToolDef<InputSchema, ListOutput>)
