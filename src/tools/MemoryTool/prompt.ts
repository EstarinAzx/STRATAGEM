import { isAutoMemoryEnabled } from '../../memdir/paths.js'
import { AUTO_MEM_KNOWLEDGE_CATEGORIES } from '../../memdir/paths.js'
import { MEMORY_TYPES } from '../../memdir/memoryTypes.js'

export const MEMORY_PIN_TOOL_NAME = 'MemoryPin'
export const MEMORY_LIST_TOOL_NAME = 'MemoryList'
export const MEMORY_UNPIN_TOOL_NAME = 'MemoryUnpin'

export const MEMORY_PIN_DESCRIPTION =
  'Save a durable memory to the auto-memory store with structured frontmatter. First-class alternative to writing the file by hand — validates type/category and ensures the file lands in the right place.'

export const MEMORY_LIST_DESCRIPTION =
  'List durable memories from the auto-memory store. Supports keyword search, type filter, and category filter. Returns a manifest with type, category, age, and one-line description per memory.'

export const MEMORY_UNPIN_DESCRIPTION =
  'Delete a memory from the auto-memory store by relative path. Use when a memory is wrong or obsolete and can be removed cleanly. Prefer updating over deleting when the underlying fact has only changed.'

export function buildMemoryPinPrompt(): string {
  const types = MEMORY_TYPES.map(t => `\`${t}\``).join(' / ')
  const cats = AUTO_MEM_KNOWLEDGE_CATEGORIES.map(c => `\`${c}\``).join(' / ')
  return `Pin a durable memory to the auto-memory store.

Inputs:
- \`name\` — short slug for the filename (no extension; underscores or hyphens are fine).
- \`type\` — one of ${types}. See the typed-memory taxonomy already in your context for what each means.
- \`description\` — one-line summary used by the relevance ranker. Be specific.
- \`body\` — the actual memory content (markdown). For \`feedback\` and \`project\` types, lead with the rule/fact, then \`**Why:**\` and \`**How to apply:**\` lines.
- \`category\` (optional) — one of ${cats}. When set, the file is placed under \`knowledge/<category>/\`. When omitted, the file is placed at the top level of the memory dir.
- \`updateIndex\` (optional, default true) — append a one-line wikilink bullet to \`index.md\`. Skip with \`false\` if you are batching pins and will update the index yourself afterward.

Frontmatter is generated automatically. Do not include a frontmatter block in \`body\`.

Idempotent: pinning a memory whose name already exists overwrites it. Use this to update memories whose facts have changed rather than deleting + re-pinning.`
}

export function buildMemoryListPrompt(): string {
  return `List durable memories from the auto-memory store.

All inputs are optional:
- \`query\` — keyword search across filename, description, title, tags, wikilinks, category. Uses the same ranker as the auto-recall path.
- \`type\` — restrict to one memory type (\`user\` / \`feedback\` / \`project\` / \`reference\`).
- \`category\` — restrict to one knowledge category.
- \`limit\` (default 30) — maximum number of memories to return.

Returns a manifest with one line per memory: \`[type] {category} filename (mtime): description\`. Use this to recall what is already pinned before pinning something new — duplicates dilute relevance ranking.`
}

export function buildMemoryUnpinPrompt(): string {
  return `Delete a memory from the auto-memory store by its relative path.

Input:
- \`path\` — relative to the memory directory, e.g. \`feedback_collaboration_style.md\` or \`knowledge/concepts/branch-workflow.md\`. Reject \`index.md\` and anything under \`daily/\`.

Prefer updating an existing memory (re-pin with the same name) when the underlying fact has only changed. Use unpin only when a memory is genuinely wrong or obsolete.`
}

export { isAutoMemoryEnabled }
