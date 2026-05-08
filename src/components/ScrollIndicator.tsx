/**
 * Terminal scrollbar indicator for fullscreen mode.
 *
 * Renders a 1-column-wide track on the right edge of the viewport with a
 * proportionally-sized thumb showing the current scroll position. Subscribes
 * to ScrollBox's imperative handle — snapshot returns a stable string key
 * so useSyncExternalStore doesn't infinite-loop on object identity.
 *
 * Click-to-jump: clicking on track outside the thumb jumps to that
 * proportional position. Drag: pressing on the thumb captures subsequent
 * mouse-move events (via onPress + event.beginDrag) so the user can drag
 * the thumb up/down to scroll. The noSelect style prevents text selection
 * from interfering with mouse events.
 */
import React, { type RefObject, useCallback, useMemo, useRef } from 'react'
import { useSyncExternalStore } from 'react'
import { Box, Text } from '../ink.js'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import type { PressEvent } from '../ink/events/press-event.js'
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

  // Drag state: anchor row at press time + scrollTop at press time. onMove
  // computes a new scrollTop from the row delta (1 row = 1 thumb step). A
  // ref keeps the values stable across renders without retriggering the
  // useCallback below.
  const dragRef = useRef<{ pressRow: number; pressScrollTop: number } | null>(
    null,
  )

  // Press handler: if the press lands on the thumb, beginDrag captures
  // subsequent move/release events so the user can drag the thumb up/down.
  // Click on track (off-thumb) falls through to the click-to-jump branch
  // below — onClick fires on release-without-drag.
  const handlePress = useCallback(
    (event: PressEvent) => {
      const s = scrollRef?.current
      if (!s) return
      const sh = s.getScrollHeight()
      const vh = s.getViewportHeight()
      if (sh <= vh) return

      // Recompute thumb geometry — captures current scroll position so we
      // know which rows are the thumb vs the track.
      const trackHeight = Math.max(3, vh - 1)
      const ratio = vh / sh
      const thumbSize = Math.max(1, Math.round(trackHeight * ratio))
      const maxScroll = sh - vh
      const scrollFraction = maxScroll > 0 ? Math.min(1, s.getScrollTop() / maxScroll) : 0
      const maxThumbTop = trackHeight - thumbSize
      const thumbTop = Math.round(scrollFraction * maxThumbTop)

      const onThumb =
        event.localRow >= thumbTop && event.localRow < thumbTop + thumbSize

      if (!onThumb || maxThumbTop <= 0) {
        // Off-thumb press — let onClick handle jump-to. Don't capture.
        return
      }

      // Capture the drag. Record press row and scrollTop; onMove maps
      // row deltas → scrollTop deltas using the inverse of the thumb-pos
      // formula so 1 thumb step = (maxScroll / maxThumbTop) scroll rows.
      const pressRow = event.row
      const pressScrollTop = s.getScrollTop()
      dragRef.current = { pressRow, pressScrollTop }

      event.beginDrag({
        onMove: (_col, row) => {
          const cur = dragRef.current
          if (!cur) return
          const handle = scrollRef?.current
          if (!handle) return
          const curSh = handle.getScrollHeight()
          const curVh = handle.getViewportHeight()
          if (curSh <= curVh) return
          const curMaxScroll = curSh - curVh
          const curTrackHeight = Math.max(3, curVh - 1)
          const curRatio = curVh / curSh
          const curThumbSize = Math.max(1, Math.round(curTrackHeight * curRatio))
          const curMaxThumbTop = curTrackHeight - curThumbSize
          if (curMaxThumbTop <= 0) return
          const scrollPerThumbStep = curMaxScroll / curMaxThumbTop
          const rowDelta = row - cur.pressRow
          const target = Math.max(
            0,
            Math.min(
              curMaxScroll,
              Math.round(cur.pressScrollTop + rowDelta * scrollPerThumbStep),
            ),
          )
          handle.scrollTo(target)
        },
        onEnd: () => {
          dragRef.current = null
        },
      })
      event.stopImmediatePropagation()
    },
    [scrollRef],
  )

  // Click handler: clicking on the track (off-thumb) jumps to that
  // proportional position. Click-on-thumb is suppressed because press
  // captures the drag (onClick won't fire after a captured drag — App
  // routes release to onEnd, not click dispatch).
  const handleClick = useCallback(
    (event: { localRow: number; stopImmediatePropagation: () => void }) => {
      const s = scrollRef?.current
      if (!s) return
      const sh = s.getScrollHeight()
      const vh = s.getViewportHeight()
      if (sh <= vh) return

      const trackHeight = Math.max(3, vh - 1)
      const clickFraction = trackHeight > 1 ? event.localRow / (trackHeight - 1) : 0
      const maxScroll = sh - vh
      const targetScroll = Math.round(clickFraction * maxScroll)
      s.scrollTo(targetScroll)
      event.stopImmediatePropagation()
    },
    [scrollRef],
  )

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
      onPress={handlePress}
      onClick={handleClick}
      noSelect={true}
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
