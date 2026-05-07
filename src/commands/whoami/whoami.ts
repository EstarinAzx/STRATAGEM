import { getActiveProviderProfile } from '../../providers/providerProfiles.js'
import type { LocalCommandCall } from '../../types/command.js'
import {
  getAnthropicApiKeyWithSource,
  getClaudeAIOAuthTokens,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { getCwd } from '../../utils/cwd.js'
import {
  getDefaultMainLoopModel,
  getMarketingNameForModel,
} from '../../utils/model/model.js'
import { getAPIProvider } from '../../utils/model/providers.js'

declare const MACRO: { VERSION: string }

function pad(label: string, width: number): string {
  return label.length >= width ? label : label + ' '.repeat(width - label.length)
}

function describeAnthropicAuth(): string {
  const oauth = getClaudeAIOAuthTokens()
  if (oauth?.accessToken) {
    const tier = oauth.subscriptionType ?? 'unknown tier'
    return `OAuth signed in · ${tier}`
  }
  const { source, hasToken } = getAnthropicApiKeyWithSource()
  if (hasToken) {
    return `API key (${source})`
  }
  if (isClaudeAISubscriber()) {
    return 'subscriber, no token in this session'
  }
  return 'not logged in'
}

export const call: LocalCommandCall = async () => {
  const profile = getActiveProviderProfile()
  const apiProvider = getAPIProvider()
  const model = getDefaultMainLoopModel()
  const marketingName = getMarketingNameForModel(model)

  const lines: string[] = []
  lines.push(`STRATAGEM X7 v${MACRO.VERSION}`)
  lines.push('')

  const w = 13
  if (profile) {
    lines.push(`${pad('Provider:', w)}${profile.name} (${profile.provider})`)
    lines.push(`${pad('  Base URL:', w)}${profile.baseUrl}`)
  } else {
    lines.push(`${pad('Provider:', w)}${apiProvider} (no active profile)`)
  }
  lines.push('')

  if (marketingName) {
    lines.push(`${pad('Model:', w)}${marketingName}`)
    lines.push(`${pad('  ID:', w)}${model}`)
  } else {
    lines.push(`${pad('Model:', w)}${model}`)
  }
  lines.push('')

  lines.push(`${pad('Anthropic:', w)}${describeAnthropicAuth()}`)
  lines.push(`${pad('CWD:', w)}${getCwd()}`)

  return { type: 'text', value: lines.join('\n') }
}
