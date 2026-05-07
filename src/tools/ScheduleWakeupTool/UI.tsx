import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import { truncate } from '../../utils/format.js'
import type { WakeupOutput } from './ScheduleWakeupTool.js'

export function renderWakeupToolUseMessage(
  input: Partial<{
    delaySeconds: number
    reason: string
  }>,
): React.ReactNode {
  const delay = input.delaySeconds != null ? `${input.delaySeconds}s` : ''
  const reason = input.reason ? truncate(input.reason, 60, true) : ''
  if (delay && reason) return `${delay} — ${reason}`
  return delay || reason
}

export function renderWakeupResultMessage(
  output: WakeupOutput,
): React.ReactNode {
  return (
    <MessageResponse>
      <Text>
        Wake-up <Text bold>{output.id}</Text>{' '}
        <Text dimColor>
          in {output.delaySeconds}s ({output.fireAtHuman})
        </Text>
      </Text>
    </MessageResponse>
  )
}
