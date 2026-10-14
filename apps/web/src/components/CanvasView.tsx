import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { CanvasModel } from '../drawing/canvasModel'
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../lib/protocol'

/**
 * Shows a model's bitmap. Drawing never goes through React: the raster
 * reports a dirty rectangle and only that region is copied to the canvas,
 * at most once per animation frame.
 */
export const CanvasView = forwardRef<HTMLCanvasElement, { model: CanvasModel; className?: string; label?: string }>(
  function CanvasView({ model, className, label }, forwarded) {
    const ref = useRef<HTMLCanvasElement>(null)
    useImperativeHandle(forwarded, () => ref.current!, [])

    useEffect(() => {
      const canvas = ref.current
      const ctx = canvas?.getContext('2d', { alpha: false })
      if (!canvas || !ctx) return
      const raster = model.raster
      const image = new ImageData(new Uint8ClampedArray(raster.pixels.buffer as ArrayBuffer), CANVAS_WIDTH, CANVAS_HEIGHT)
      let frame = 0
      const flush = () => {
        frame = 0
        const rect = raster.takeDirty()
        if (rect) ctx.putImageData(image, 0, 0, rect.x, rect.y, rect.w, rect.h)
      }
      raster.onDirty = () => {
        if (!frame) frame = requestAnimationFrame(flush)
      }
      raster.takeDirty()
      ctx.putImageData(image, 0, 0)
      return () => {
        raster.onDirty = null
        if (frame) cancelAnimationFrame(frame)
      }
    }, [model])

    return (
      <canvas
        ref={ref}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        className={className}
        role="img"
        aria-label={label ?? 'Drawing canvas'}
      />
    )
  },
)
