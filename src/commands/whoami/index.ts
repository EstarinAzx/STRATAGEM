/**
 * /whoami — show provider, model, auth state, and working directory in one shot.
 * Useful diagnostic when the user is unsure whether they're logged in,
 * which provider is active, what model is resolved, etc.
 */
import type { Command } from '../../commands.js'

const whoami = {
  type: 'local',
  name: 'whoami',
  description: 'Show active provider, model, auth state, and working directory',
  supportsNonInteractive: true,
  load: () => import('./whoami.js'),
} satisfies Command

export default whoami
