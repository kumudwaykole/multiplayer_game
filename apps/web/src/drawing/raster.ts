import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../lib/protocol'

/**
 * Deterministic 1000 × 700 RGBA bitmap. Everything is integer pixel work
 * with no anti-aliasing, so the same operations give the same pixels in
 * every browser (the skribbl approach). Brushes are filled discs stamped
 * along Bresenham lines; fill is an exact-colour 4-connected scanline fill.
 */

export const WHITE = 0xffffffff

/** "#rrggbb" to a little-endian RGBA word (ImageData byte order). */
export function packColor(hex: string): number {
  const value = Number.parseInt(hex.slice(1, 7), 16)
  const r = (value >> 16) & 0xff
  const g = (value >> 8) & 0xff
  const b = value & 0xff
  return ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0
}

/** For each row of a disc: [dy, halfWidth]. Cached per brush width. */
const discCache = new Map<number, Int16Array>()

function discSpans(width: number): Int16Array {
  let spans = discCache.get(width)
  if (spans) return spans
  const r = width / 2
  const reach = Math.floor(r)
  const rows: number[] = []
  for (let dy = -reach; dy <= reach; dy++) {
    const remaining = r * r - dy * dy
    if (remaining < 0) continue
    rows.push(dy, Math.floor(Math.sqrt(remaining)))
  }
  spans = Int16Array.from(rows)
  discCache.set(width, spans)
  return spans
}

export class Raster {
  readonly width = CANVAS_WIDTH
  readonly height = CANVAS_HEIGHT
  readonly pixels: Uint32Array
  /** Dirty rectangle since the last flush (inclusive); x0 > x1 means clean. */
  dirtyX0 = 0
  dirtyY0 = 0
  dirtyX1 = CANVAS_WIDTH - 1
  dirtyY1 = CANVAS_HEIGHT - 1
  onDirty: (() => void) | null = null

  constructor() {
    this.pixels = new Uint32Array(this.width * this.height)
    this.pixels.fill(WHITE)
  }

  get isDirty(): boolean {
    return this.dirtyX0 <= this.dirtyX1
  }

  takeDirty(): { x: number; y: number; w: number; h: number } | null {
    if (!this.isDirty) return null
    const rect = { x: this.dirtyX0, y: this.dirtyY0, w: this.dirtyX1 - this.dirtyX0 + 1, h: this.dirtyY1 - this.dirtyY0 + 1 }
    this.dirtyX0 = this.width
    this.dirtyY0 = this.height
    this.dirtyX1 = -1
    this.dirtyY1 = -1
    return rect
  }

  clear(color = WHITE): void {
    this.pixels.fill(color)
    this.markAll()
  }

  copyFrom(source: Uint32Array): void {
    this.pixels.set(source)
    this.markAll()
  }

  /** Filled disc of diameter `brush` centred on (cx, cy). */
  stamp(cx: number, cy: number, brush: number, color: number): void {
    const spans = discSpans(brush)
    const { width, height, pixels } = this
    for (let i = 0; i < spans.length; i += 2) {
      const y = cy + spans[i]!
      if (y < 0 || y >= height) continue
      const half = spans[i + 1]!
      const x0 = Math.max(0, cx - half)
      const x1 = Math.min(width - 1, cx + half)
      if (x0 > x1) continue
      const row = y * width
      pixels.fill(color, row + x0, row + x1 + 1)
    }
    const reach = Math.floor(brush / 2)
    this.mark(cx - reach, cy - reach, cx + reach, cy + reach)
  }

  /** Stamps along the Bresenham line from (x0, y0), exclusive, to (x1, y1), inclusive. */
  line(x0: number, y0: number, x1: number, y1: number, brush: number, color: number): void {
    const dx = Math.abs(x1 - x0)
    const dy = -Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    let x = x0
    let y = y0
    while (x !== x1 || y !== y1) {
      const e2 = 2 * err
      if (e2 >= dy) {
        err += dy
        x += sx
      }
      if (e2 <= dx) {
        err += dx
        y += sy
      }
      this.stamp(x, y, brush, color)
    }
  }

  /** Exact-colour flood fill (4-connected), scanline based. */
  fill(startX: number, startY: number, color: number): void {
    const { width, height, pixels } = this
    if (startX < 0 || startY < 0 || startX >= width || startY >= height) return
    const target = pixels[startY * width + startX]!
    if (target === color) return
    const stack: number[] = [startX, startY]
    let minX = startX
    let maxX = startX
    let minY = startY
    let maxY = startY
    while (stack.length > 0) {
      const y = stack.pop()!
      const x = stack.pop()!
      const row = y * width
      if (pixels[row + x] !== target) continue
      let left = x
      while (left > 0 && pixels[row + left - 1] === target) left--
      let right = x
      while (right < width - 1 && pixels[row + right + 1] === target) right++
      pixels.fill(color, row + left, row + right + 1)
      if (left < minX) minX = left
      if (right > maxX) maxX = right
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      for (const ny of [y - 1, y + 1]) {
        if (ny < 0 || ny >= height) continue
        const nrow = ny * width
        let inRun = false
        for (let nx = left; nx <= right; nx++) {
          if (pixels[nrow + nx] === target) {
            if (!inRun) {
              stack.push(nx, ny)
              inRun = true
            }
          } else {
            inRun = false
          }
        }
      }
    }
    this.mark(minX, minY, maxX, maxY)
  }

  /** FNV-1a over all pixels, for cross-browser determinism checks. */
  hash(): string {
    let h = 0x811c9dc5
    const { pixels } = this
    for (let i = 0; i < pixels.length; i++) {
      h ^= pixels[i]!
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  }

  private markAll(): void {
    this.mark(0, 0, this.width - 1, this.height - 1)
  }

  private mark(x0: number, y0: number, x1: number, y1: number): void {
    const wasClean = !this.isDirty
    this.dirtyX0 = Math.max(0, Math.min(this.dirtyX0, x0))
    this.dirtyY0 = Math.max(0, Math.min(this.dirtyY0, y0))
    this.dirtyX1 = Math.min(this.width - 1, Math.max(this.dirtyX1, x1))
    this.dirtyY1 = Math.min(this.height - 1, Math.max(this.dirtyY1, y1))
    if (wasClean) this.onDirty?.()
  }
}
