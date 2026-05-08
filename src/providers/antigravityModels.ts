/**
 * Antigravity model catalog.
 *
 * The `id` is the upstream model name sent to the Code Assist proxy in
 * the envelope's `model` field. These are the only models Antigravity
 * actually serves — `claude-opus-4-6` (without `-thinking`), for
 * example, does NOT exist on Antigravity, even though it's a valid
 * Anthropic model name. Sending an unknown model gets you "model X is
 * not available on your antigravity deployment".
 *
 * Used by:
 *   - ProviderManager AntigravityOAuthSetup (4/4 model picker)
 *   - ProviderManager edit-antigravity flow
 *   - /model slash command (when the active profile is antigravity)
 */

export interface AntigravityModelOption {
  id: string
  label: string
  description: string
}

export const ANTIGRAVITY_MODEL_OPTIONS: AntigravityModelOption[] = [
  {
    id: 'gemini-3-pro-preview',
    label: 'Gemini 3 Pro (preview)',
    description: "Google's flagship — best for long context + reasoning",
  },
  {
    id: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro (preview)',
    description: 'Newer 3.1 Pro variant — same family, fresher snapshot',
  },
  {
    id: 'gemini-3-flash-preview',
    label: 'Gemini 3 Flash (preview)',
    description: 'Faster + cheaper than Pro — good for tool-heavy loops',
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    description: 'Anthropic Sonnet repackaged through Antigravity',
  },
  {
    id: 'claude-opus-4-6-thinking',
    label: 'Claude Opus 4.6 (thinking)',
    description: 'Anthropic Opus with extended thinking — deepest reasoning',
  },
]

export const ANTIGRAVITY_DEFAULT_MODEL = 'gemini-3-pro-preview'

/** Quick check used by the /model picker to decide which UI to render. */
export function isAntigravityModelId(id: string): boolean {
  return ANTIGRAVITY_MODEL_OPTIONS.some(m => m.id === id)
}
