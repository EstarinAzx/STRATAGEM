import type { Command } from '../../commands.js'

const autonomy = {
  type: 'local-jsx',
  name: 'autonomy',
  description: 'Set autonomy mode: off, plan, smart, or aggressive',
  load: () => import('./autonomy.js'),
} satisfies Command

export default autonomy
