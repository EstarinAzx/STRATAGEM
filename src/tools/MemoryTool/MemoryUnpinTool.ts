import { unlink } from 'fs/promises'
import { isAbsolute, join, normalize, relative, sep } from 'path'
import { z } from 'zod/v4'
import { getAutoMemPath } from '../../memdir/paths.js'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  buildMemoryUnpinPrompt,
  isAutoMemoryEnabled,
  MEMORY_UNPIN_DESCRIPTION,
  MEMORY_UNPIN_TOOL_NAME,
} from './prompt.js'
import { renderUnpinResultMessage, renderUnpinToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    path: z
      .string()
      .describe(
        'Relative path within the memory directory, e.g. "feedback_collaboration_style.md" or "knowledge/concepts/branch-workflow.md".',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    relativePath: z.string(),
    absolutePath: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type UnpinOutput = z.infer<OutputSchema>

function isPathSafe(rawPath: string, memDir: string): { ok: true; absolute: string } | { ok: false; reason: string } {
  if (isAbsolute(rawPath)) {
    return { ok: false, reason: 'Path must be relative to the memory directory.' }
  }
  const normalized = normalize(rawPath)
  if (normalized.startsWith('..') || normalized.split(sep).includes('..')) {
    return { ok: false, reason: 'Path traversal (..) is not allowed.' }
  }
  if (!normalized.endsWith('.md')) {
    return { ok: false, reason: 'Only .md files can be unpinned.' }
  }
  if (normalized === 'index.md' || normalized === 'MEMORY.md') {
    return { ok: false, reason: `Refusing to unpin reserved file ${normalized}.` }
  }
  if (normalized.startsWith(`daily${sep}`) || normalized.startsWith('daily/')) {
    return { ok: false, reason: 'Daily logs cannot be unpinned through this tool.' }
  }
  const absolute = join(memDir, normalized)
  // Final containment check — defense in depth against any normalize edge case.
  const rel = relative(memDir, absolute)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, reason: 'Resolved path escapes the memory directory.' }
  }
  return { ok: true, absolute }
}

export const MemoryUnpinTool = buildTool({
  name: MEMORY_UNPIN_TOOL_NAME,
  searchHint: 'delete a durable memory',
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
    return input.path
  },
  async description() {
    return MEMORY_UNPIN_DESCRIPTION
  },
  async prompt() {
    return buildMemoryUnpinPrompt()
  },
  async validateInput(input): Promise<ValidationResult> {
    const memDir = getAutoMemPath()
    const check = isPathSafe(input.path, memDir)
    if (!check.ok) {
      return { result: false, message: check.reason, errorCode: 1 }
    }
    return { result: true }
  },
  async call({ path }) {
    const memDir = getAutoMemPath()
    const check = isPathSafe(path, memDir)
    if (!check.ok) {
      throw new Error(check.reason)
    }
    await unlink(check.absolute)
    return {
      data: {
        relativePath: path,
        absolutePath: check.absolute,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Unpinned memory ${output.relativePath}.`,
    }
  },
  renderToolUseMessage: renderUnpinToolUseMessage,
  renderToolResultMessage: renderUnpinResultMessage,
} satisfies ToolDef<InputSchema, UnpinOutput>)
