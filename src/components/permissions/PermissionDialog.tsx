import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { Theme } from '../../utils/theme.js'
import type { WorkerBadgeProps } from './WorkerBadge.js'

type Props = {
  title: string
  subtitle?: React.ReactNode
  color?: keyof Theme
  titleColor?: keyof Theme
  innerPaddingX?: number
  workerBadge?: WorkerBadgeProps
  titleRight?: React.ReactNode
  children: React.ReactNode
}

/**
 * Breach-HUD permission dialog.
 *
 * Visual language:
 *   ┌─ BREACH // <TITLE> ─────────────────────────┐
 *   │  <subtitle line if any> @worker             │
 *   │  <children — request body, options>         │
 *   └─────────────────────────────────────────────┘
 *
 * Title is hoisted into the top border (same `borderText` pattern as
 * BREACH // COMMAND MATRIX / STATUS BUS), uppercased and BREACH-prefixed
 * to match the rest of the chrome. Subtitle + workerBadge render as a
 * slim contextual line *only when present* — no redundant inner title row.
 */
export function PermissionDialog({
  title,
  subtitle,
  color = 'permission',
  titleColor,
  innerPaddingX = 1,
  workerBadge,
  titleRight,
  children,
}: Props): React.ReactNode {
  const breachTitle = ` BREACH // ${title.toUpperCase()} `

  const hasContextRow =
    subtitle != null || workerBadge != null || titleRight != null

  const contextRow = hasContextRow ? (
    <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
      <Box flexDirection="row" gap={1}>
        {subtitle != null &&
          (typeof subtitle === 'string' ? (
            <Text color={titleColor ?? color} dimColor wrap="truncate-start">
              {subtitle}
            </Text>
          ) : (
            subtitle
          ))}
        {workerBadge && (
          <Text dimColor>
            {'· '}@{workerBadge.name}
          </Text>
        )}
      </Box>
      {titleRight}
    </Box>
  ) : null

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={color}
      marginTop={1}
      paddingX={innerPaddingX}
      borderText={{
        content: breachTitle,
        position: 'top',
        align: 'start',
        offset: 1,
      }}
    >
      {contextRow}
      <Box flexDirection="column">{children}</Box>
    </Box>
  )
}
