import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { dirname, join, sep } from 'path'
import { z } from 'zod/v4'
import {
  AUTO_MEM_KNOWLEDGE_CATEGORIES,
  getAutoMemEntrypoint,
  getAutoMemPath,
} from '../../memdir/paths.js'
import { MEMORY_TYPES } from '../../memdir/memoryTypes.js'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  buildMemoryPinPrompt,
  isAutoMemoryEnabled,
  MEMORY_PIN_DESCRIPTION,
  MEMORY_PIN_TOOL_NAME,
} from './prompt.js'
import { renderPinResultMessage, renderPinToolUseMessage } from './UI.js'

const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_\-.]{0,79}$/

const inputSchema = lazySchema(() =>
  z.strictObject({
    name: z
      .string()
      .describe(
        'Filename slug (no .md extension). Letters, digits, underscores, hyphens, dots. 1–80 chars, must start with alphanumeric.',
      ),
    type: z
      .enum([...MEMORY_TYPES])
      .describe(
        'Memory type. user = facts about the user, feedback = guidance/corrections, project = ongoing work context, reference = pointers to external systems.',
      ),
    description: z
      .string()
      .min(1)
      .describe(
        'One-line description used by the relevance ranker. Be specific.',
      ),
    body: z
      .string()
      .min(1)
      .describe(
        'Memory body in markdown. Do not include a frontmatter block — it is generated.',
      ),
    category: z
      .enum([...AUTO_MEM_KNOWLEDGE_CATEGORIES])
      .optional()
      .describe(
        'Optional knowledge category. When set, the file is placed under knowledge/<category>/. When omitted, file is placed at the top level of the memory dir.',
      ),
    updateIndex: z
      .boolean()
      .optional()
      .describe(
        'When true (default), append a wikilink bullet to index.md. Skip with false when batching pins.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    relativePath: z.string(),
    absolutePath: z.string(),
    created: z.boolean(),
    indexUpdated: z.boolean(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type PinOutput = z.infer<OutputSchema>

function buildFrontmatter(name: string, description: string, type: string): string {
  const escaped = (s: string) => s.replace(/\r?\n/g, ' ').trim()
  return [
    '---',
    `name: ${escaped(name)}`,
    `description: ${escaped(description)}`,
    `type: ${type}`,
    '---',
    '',
    '',
  ].join('\n')
}

function buildIndexLine(relativePath: string, description: string): string {
  const wikilinkTarget = relativePath.replace(/\.md$/, '').split(sep).join('/')
  return `- [[${wikilinkTarget}]] — ${description}`
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function appendIndexLine(
  indexPath: string,
  line: string,
): Promise<boolean> {
  let existing = ''
  try {
    existing = await readFile(indexPath, 'utf-8')
  } catch {
    existing = ''
  }
  // Idempotent: if the wikilink target is already referenced anywhere in
  // index.md, leave the file alone (the description may have been edited
  // by the user; we don't want to clobber it).
  const wikilinkTarget = line.match(/\[\[([^\]]+)\]\]/)?.[1]
  if (wikilinkTarget && existing.includes(`[[${wikilinkTarget}]]`)) {
    return false
  }
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
  await writeFile(indexPath, existing + sep + line + '\n', 'utf-8')
  return true
}

export const MemoryPinTool = buildTool({
  name: MEMORY_PIN_TOOL_NAME,
  searchHint: 'save a durable memory',
  maxResultSizeChars: 10_000,
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
    return `${input.type}/${input.name}: ${input.description}`
  },
  async description() {
    return MEMORY_PIN_DESCRIPTION
  },
  async prompt() {
    return buildMemoryPinPrompt()
  },
  async validateInput(input): Promise<ValidationResult> {
    if (!SAFE_NAME_RE.test(input.name)) {
      return {
        result: false,
        message: `Invalid name '${input.name}'. Use letters/digits/_/-/. , starting alphanumeric, max 80 chars.`,
        errorCode: 1,
      }
    }
    if (input.name === 'index' || input.name === 'MEMORY') {
      return {
        result: false,
        message: `'${input.name}' is reserved.`,
        errorCode: 2,
      }
    }
    return { result: true }
  },
  async call({ name, type, description, body, category, updateIndex = true }) {
    const memDir = getAutoMemPath()
    const relativePath = category
      ? join('knowledge', category, `${name}.md`)
      : `${name}.md`
    const absolutePath = join(memDir, relativePath)

    await mkdir(dirname(absolutePath), { recursive: true })

    const existed = await fileExists(absolutePath)
    const content = buildFrontmatter(name, description, type) + body.trimEnd() + '\n'
    await writeFile(absolutePath, content, 'utf-8')

    let indexUpdated = false
    if (updateIndex) {
      indexUpdated = await appendIndexLine(
        getAutoMemEntrypoint(),
        buildIndexLine(relativePath, description),
      )
    }

    return {
      data: {
        relativePath,
        absolutePath,
        created: !existed,
        indexUpdated,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const verb = output.created ? 'Pinned' : 'Updated'
    const idx = output.indexUpdated ? ' (index.md updated)' : ''
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `${verb} memory ${output.relativePath}${idx}.`,
    }
  },
  renderToolUseMessage: renderPinToolUseMessage,
  renderToolResultMessage: renderPinResultMessage,
} satisfies ToolDef<InputSchema, PinOutput>)
