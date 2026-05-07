import React from 'react'
import { useIsInsideModal } from '../../context/modalContext.js'
import { Box } from '../../ink.js'
import type { Theme } from '../../utils/theme.js'
import { Divider } from './Divider.js'

type PaneProps = {
  children: React.ReactNode
  /**
   * Theme color for the top border line.
   */
  color?: keyof Theme
  /**
   * Optional breach-style label rendered into the top border:
   * `─ BREACH // <TITLE> ─...`. When unset, the border is plain.
   * Provide a short identifier for the screen (e.g. "MODEL SELECT",
   * "STATS", "PERMISSIONS") to distinguish surfaces at a glance.
   */
  title?: string
}

/**
 * A pane — a region of the terminal that appears below the REPL prompt,
 * bounded by a colored top line with a one-row gap above and horizontal
 * padding. Used by all slash-command screens: /config, /help, /plugins,
 * /sandbox, /stats, /permissions.
 *
 * For confirm/cancel dialogs (Esc to dismiss, Enter to confirm), use
 * `<Dialog>` instead — it registers its own keybindings. For a full
 * rounded-border card, use `<Panel>`.
 *
 * Submenus rendered inside a Pane should use `hideBorder` on their Dialog
 * so the Pane's border remains the single frame.
 *
 * @example
 * <Pane color="permission" title="SANDBOX">
 *   <Tabs title="Sandbox:">...</Tabs>
 * </Pane>
 */
export function Pane({
  children,
  color,
  title,
}: PaneProps): React.ReactNode {
  const insideModal = useIsInsideModal()
  const borderColor = color ?? 'promptBorder'
  const borderText = title
    ? {
        content: ` BREACH // ${title.toUpperCase()} `,
        position: 'top' as const,
        align: 'start' as const,
        offset: 1,
      }
    : undefined

  if (insideModal) {
    return (
      <Box
        flexDirection="column"
        paddingX={1}
        flexShrink={0}
        borderStyle="single"
        borderColor={borderColor}
        paddingY={0}
        borderText={borderText}
      >
        {children}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingTop={1}>
      <Divider color={borderColor} />
      <Box
        flexDirection="column"
        paddingX={2}
        borderStyle="single"
        borderColor={borderColor}
        borderText={borderText}
        paddingY={0}
      >
        {children}
      </Box>
    </Box>
  )
}
