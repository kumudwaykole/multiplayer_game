import { memo, useEffect } from 'react'
import { BRUSH_SIZES, PALETTE, type Tool } from '../drawing/palette'
import { cx } from '../lib/toast'
import type { BrushState } from './DrawingBoard'

interface ToolbarProps {
  brush: BrushState
  onChange: (next: BrushState) => void
  onUndo: () => void
  onClear: () => void
}

const TOOLS: Array<{ tool: Tool; label: string; key: string; icon: string }> = [
  { tool: 'pen', label: 'Brush', key: 'B', icon: 'M4 20c3 0 5-1 6-3l9-9-3-3-9 9c-2 1-3 3-3 6zM14 6l3 3' },
  { tool: 'eraser', label: 'Eraser', key: 'E', icon: 'M8 20h12M5 15l8-8 6 6-5 5H9z' },
  { tool: 'fill', label: 'Fill', key: 'F', icon: 'M4 12l7-7 8 8-7 7zM19 15s2 2.5 2 4a2 2 0 01-4 0c0-1.5 2-4 2-4z' },
]

function ToolButton(props: { label: string; active?: boolean; onClick: () => void; icon: string; shortcut?: string }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-label={props.shortcut ? `${props.label} (${props.shortcut})` : props.label}
      aria-pressed={props.active}
      title={props.shortcut ? `${props.label} (${props.shortcut})` : props.label}
      className={cx(
        'grid size-9 place-items-center rounded-lg border-2 transition',
        props.active ? 'border-ink bg-sun' : 'border-line bg-white hover:border-ink/40',
      )}
    >
      <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
        <path d={props.icon} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

/** Drawer tools: colour, palette, brush size, brush/eraser/fill, undo and clear. */
export const Toolbar = memo(function Toolbar({ brush, onChange, onUndo, onClear }: ToolbarProps) {
  // Keyboard shortcuts, ignored while typing in the chat.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        onUndo()
        return
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const tool = TOOLS.find((t) => t.key.toLowerCase() === event.key.toLowerCase())
      if (tool) onChange({ ...brush, tool: tool.tool })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [brush, onChange, onUndo])

  const pickColor = (hex: string) => onChange({ ...brush, color: hex, tool: brush.tool === 'eraser' ? 'pen' : brush.tool })

  return (
    <div className="panel flex flex-wrap items-center justify-center gap-x-2 gap-y-1.5 px-2 py-1.5" role="toolbar" aria-label="Drawing tools">
      <div
        className="size-9 shrink-0 rounded-lg border-2 border-ink shadow-[inset_0_0_0_2px_#fff]"
        style={{ background: brush.color }}
        aria-label={`Current colour ${PALETTE.find((c) => c.hex === brush.color)?.name ?? brush.color}`}
        role="img"
      />
      <div className="grid grid-cols-13 overflow-hidden rounded-lg border-2 border-ink" role="radiogroup" aria-label="Colours">
        {PALETTE.map((c) => (
          <button
            key={c.hex}
            type="button"
            role="radio"
            aria-checked={brush.color === c.hex}
            aria-label={c.name}
            title={c.name}
            onClick={() => pickColor(c.hex)}
            className={cx(
              'size-[1.1rem] transition-transform hover:z-10 hover:scale-125 sm:size-[1.3rem]',
              brush.color === c.hex && 'z-10 scale-110 outline-2 outline-offset-[-3px] outline-white',
            )}
            style={{ background: c.hex }}
          />
        ))}
      </div>
      <div className="flex items-center gap-1" role="radiogroup" aria-label="Brush size">
        {BRUSH_SIZES.map((size) => (
          <button
            key={size}
            type="button"
            role="radio"
            aria-checked={brush.size === size}
            aria-label={`Brush size ${size}`}
            onClick={() => onChange({ ...brush, size, tool: brush.tool === 'fill' ? 'pen' : brush.tool })}
            className={cx(
              'grid size-9 place-items-center rounded-lg border-2 transition',
              brush.size === size ? 'border-ink bg-sun' : 'border-line bg-white hover:border-ink/40',
            )}
          >
            <span className="rounded-full bg-ink" style={{ width: 3 + size * 0.5, height: 3 + size * 0.5 }} />
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1">
        {TOOLS.map((t) => (
          <ToolButton
            key={t.tool}
            label={t.label}
            shortcut={t.key}
            icon={t.icon}
            active={brush.tool === t.tool}
            onClick={() => onChange({ ...brush, tool: t.tool })}
          />
        ))}
      </div>
      <div className="flex items-center gap-1">
        <ToolButton label="Undo" shortcut="Ctrl+Z" icon="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3" onClick={onUndo} />
        <ToolButton label="Clear canvas" icon="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" onClick={onClear} />
      </div>
    </div>
  )
})
