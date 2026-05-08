import { Event } from './event.js'

/**
 * Active drag handler installed by a component during onPress via
 * event.beginDrag(...). The Ink App routes subsequent move/release
 * events to it until end fires (or the handler is cleared).
 */
export type DragHandler = {
  /** Fired for each drag-motion event after the press. */
  onMove?: (col: number, row: number) => void
  /** Fired on release (left-button up). */
  onEnd?: (col: number, row: number) => void
}

/**
 * Mouse-down event. Fired on left-button press inside <AlternateScreen>,
 * before the selection system starts a text selection. Bubbles through
 * parentNode like ClickEvent.
 *
 * Default behavior: a press without beginDrag falls through to the normal
 * text-selection start in App.handleMouseEvent. Calling beginDrag captures
 * subsequent mouse-move + mouse-up events for that single drag — selection
 * is suppressed until the drag ends.
 */
export class PressEvent extends Event {
  /** 0-indexed screen column of the press. */
  readonly col: number
  /** 0-indexed screen row of the press. */
  readonly row: number
  /** Press column relative to the current handler's Box (col - box.x). */
  localCol = 0
  /** Press row relative to the current handler's Box (row - box.y). */
  localRow = 0

  // Captured during dispatch via beginDrag(); read by App after dispatch.
  private dragHandler: DragHandler | null = null

  constructor(col: number, row: number) {
    super()
    this.col = col
    this.row = row
  }

  /**
   * Capture this drag. Subsequent mouse-move + mouse-up events route to
   * the supplied handler instead of starting a text selection. Calling
   * twice replaces the previous handler.
   */
  beginDrag(handler: DragHandler): void {
    this.dragHandler = handler
  }

  /** Internal: read the drag handler installed during dispatch. */
  _getDragHandler(): DragHandler | null {
    return this.dragHandler
  }
}
