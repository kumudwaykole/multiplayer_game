import { useEffect, useRef, type ReactNode } from 'react'
import type { CanvasSync } from '../drawing/canvasSync'
import type { Tool } from '../drawing/palette'
import { CANVAS_HEIGHT, CANVAS_WIDTH, type Point } from '../lib/protocol'
import { cx } from '../lib/toast'
import { CanvasView } from './CanvasView'

export interface BrushState {
  tool: Tool
  color: string
  size: number
}

interface DrawingBoardProps {
  sync: CanvasSync
  canDraw: boolean
  brush: BrushState
  children?: ReactNode
}

function toLogical(canvas: HTMLCanvasElement, event: PointerEvent): Point {
  const rect = canvas.getBoundingClientRect()
  const x = Math.round(((event.clientX - rect.left) / rect.width) * CANVAS_WIDTH)
  const y = Math.round(((event.clientY - rect.top) / rect.height) * CANVAS_HEIGHT)
  return [Math.min(CANVAS_WIDTH - 1, Math.max(0, x)), Math.min(CANVAS_HEIGHT - 1, Math.max(0, y))]
}

/** The canvas plus pointer input for the drawer and the overlays (word choice, results). */
export function DrawingBoard({ sync, canDraw, brush, children }: DrawingBoardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cursorRef = useRef<HTMLDivElement>(null)
  // Handlers read the latest brush without being re-attached on every change.
  const brushRef = useRef(brush)
  useEffect(() => {
    brushRef.current = brush
  }, [brush])

  useEffect(() => {
    const canvas = canvasRef.current
    const cursor = cursorRef.current
    if (!canvas || !cursor || !canDraw) return
    let activePointer: number | null = null

    const moveCursor = (event: PointerEvent) => {
      const { tool, size } = brushRef.current
      if (tool === 'fill' || event.pointerType === 'touch') {
        cursor.style.opacity = '0'
        return
      }
      const rect = canvas.getBoundingClientRect()
      const diameter = Math.max(4, (size * rect.width) / CANVAS_WIDTH)
      cursor.style.width = `${diameter}px`
      cursor.style.height = `${diameter}px`
      cursor.style.transform = `translate(${event.clientX - rect.left - diameter / 2}px, ${event.clientY - rect.top - diameter / 2}px)`
      cursor.style.opacity = '1'
    }

    const down = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return
      if (activePointer !== null) return
      event.preventDefault()
      const point = toLogical(canvas, event)
      const { tool, color, size } = brushRef.current
      if (tool === 'fill') {
        sync.fill(point, color)
        return
      }
      canvas.setPointerCapture(event.pointerId)
      activePointer = event.pointerId
      sync.beginStroke(tool === 'eraser' ? 'eraser' : 'pen', color, size, point, performance.now())
    }

    const move = (event: PointerEvent) => {
      moveCursor(event)
      if (event.pointerId !== activePointer) return
      const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : []
      const now = performance.now()
      for (const e of events.length > 0 ? events : [event]) sync.addPoint(toLogical(canvas, e), now)
    }

    const up = (event: PointerEvent) => {
      if (event.pointerId !== activePointer) return
      activePointer = null
      sync.endStroke()
    }

    const leave = () => {
      cursor.style.opacity = '0'
    }

    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointercancel', up)
    canvas.addEventListener('lostpointercapture', up)
    canvas.addEventListener('pointerleave', leave)
    return () => {
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointercancel', up)
      canvas.removeEventListener('lostpointercapture', up)
      canvas.removeEventListener('pointerleave', leave)
      sync.endStroke()
      cursor.style.opacity = '0'
    }
  }, [canDraw, sync])

  return (
    <div className="board-frame panel relative overflow-hidden">
      <CanvasView
        ref={canvasRef}
        model={sync.model}
        label={canDraw ? 'Your drawing canvas' : 'Drawing in progress'}
        className={cx(
          'absolute inset-0 size-full rounded-[inherit]',
          // Only block page scrolling/zooming while this player can draw.
          canDraw && 'touch-none',
          canDraw && (brush.tool === 'fill' ? 'cursor-crosshair' : 'cursor-none'),
        )}
      />
      <div
        ref={cursorRef}
        aria-hidden="true"
        className="pointer-events-none absolute top-0 left-0 rounded-full border-2 border-ink/80 opacity-0 shadow-[0_0_0_1.5px_rgb(255_255_255/0.85)]"
        style={{ background: brush.tool === 'eraser' ? 'rgb(255 255 255 / 0.6)' : `${brush.color}66` }}
      />
      {children}
    </div>
  )
}
