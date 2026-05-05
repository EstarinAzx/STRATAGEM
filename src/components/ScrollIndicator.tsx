/**
 * Terminal scrollbar indicator for fullscreen mode.
 *
 * Renders a 1-column-wide track on the right edge of the viewport with a
 * proportionally-sized thumb showing the current scroll position. Subscribes
 * to ScrollBox's imperative handle — snapshot returns a stable string key
 * so useSyncExternalStore doesn't infinite-loop on object identity.
 */
import React, { type RefObject, useMemo, useRef } from 'react'
import { useSyncExternalStore } from 'react'
import { Box, Text } from '../ink.js'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'

const NOOP_UNSUB = () => {}

export function ScrollIndicator({
  scrollRef,
}: {
  scrollRef: RefObject<ScrollBoxHandle | null>
}) {
  const { rows } = useTerminalSize()

  const subscribe = useMemo(
    () => (listener: () => void) =>
      scrollRef?.current?.subscribe(listener) ?? NOOP_UNSUB,
    [scrollRef],
  )

  // Return a primitive string so useSyncExternalStore can compare with ===.
  // Returning an object would create a new reference every snapshot call →
  // infinite re-render loop.
  const getSnapshot = useMemo(
    () => (): string => {
      const s = scrollRef?.current
      if (!s) return '0:0:0'
      const top = s.getScrollTop() + s.getPendingDelta()
      const height = s.getScrollHeight()
      const vp = s.getViewportHeight()
      return `${top}:${height}:${vp}`
    },
    [scrollRef],
  )

  const snapshotKey = useSyncExternalStore(subscribe, getSnapshot)
  const parts = snapshotKey.split(':')
  const scrollTop = Number(parts[0])
  const scrollHeight = Number(parts[1])
  const viewportHeight = Number(parts[2])

  // Don't render if content fits in viewport
  if (scrollHeight <= viewportHeight || viewportHeight < 3) {
    return null
  }

  // Calculate track height (use viewport height minus padding)
  const trackHeight = Math.max(3, viewportHeight - 1)

  // Calculate thumb size — proportional to viewport/content ratio
  const ratio = viewportHeight / scrollHeight
  const thumbSize = Math.max(1, Math.round(trackHeight * ratio))

  // Calculate thumb position
  const maxScroll = scrollHeight - viewportHeight
  const scrollFraction = maxScroll > 0 ? Math.min(1, scrollTop / maxScroll) : 0
  const maxThumbTop = trackHeight - thumbSize
  const thumbTop = Math.round(scrollFraction * maxThumbTop)

  // Build the track as an array of characters
  const track: string[] = []
  for (let i = 0; i < trackHeight; i++) {
    if (i >= thumbTop && i < thumbTop + thumbSize) {
      track.push('█')
    } else {
      track.push('│')
    }
  }

  return (
    <Box
      position="absolute"
      top={0}
      right={0}
      bottom={0}
      width={1}
      flexDirection="column"
    >
      {track.map((char, i) => (
        <Text
          key={i}
          color={char === '█' ? 'cyan' : '#333333'}
        >
          {char}
        </Text>
      ))}
    </Box>
  )
}
