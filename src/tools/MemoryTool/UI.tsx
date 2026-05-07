import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import { truncate } from '../../utils/format.js'
import type { ListOutput } from './MemoryListTool.js'
import type { PinOutput } from './MemoryPinTool.js'
import type { UnpinOutput } from './MemoryUnpinTool.js'

export function renderPinToolUseMessage(
  input: Partial<{
    name: string
    type: string
    category: string
  }>,
): React.ReactNode {
  const tag = input.type ? `[${input.type}] ` : ''
  const cat = input.category ? `{${input.category}} ` : ''
  return `${tag}${cat}${input.name ?? ''}`
}

export function renderPinResultMessage(output: PinOutput): React.ReactNode {
  return (
    <MessageResponse>
      <Text>
        {output.created ? 'Pinned' : 'Updated'}{' '}
        <Text bold>{output.relativePath}</Text>
      </Text>
    </MessageResponse>
  )
}

export function renderListToolUseMessage(
  input: Partial<{ query: string; type: string; category: string }>,
): React.ReactNode {
  const parts: string[] = []
  if (input.query) parts.push(`q="${truncate(input.query, 40, true)}"`)
  if (input.type) parts.push(`type=${input.type}`)
  if (input.category) parts.push(`cat=${input.category}`)
  return parts.join(' ') || '(all)'
}

export function renderListResultMessage(output: ListOutput): React.ReactNode {
  if (output.memories.length === 0) {
    return (
      <MessageResponse>
        <Text dimColor>No memories matched.</Text>
      </MessageResponse>
    )
  }
  return (
    <MessageResponse>
      <Text>
        {output.memories.length} memor{output.memories.length === 1 ? 'y' : 'ies'}
        {output.truncated ? ' (truncated)' : ''}
      </Text>
    </MessageResponse>
  )
}

export function renderUnpinToolUseMessage(
  input: Partial<{ path: string }>,
): React.ReactNode {
  return input.path ?? ''
}

export function renderUnpinResultMessage(output: UnpinOutput): React.ReactNode {
  return (
    <MessageResponse>
      <Text>
        Unpinned <Text bold>{output.relativePath}</Text>
      </Text>
    </MessageResponse>
  )
}
