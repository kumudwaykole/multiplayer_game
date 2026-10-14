import { memo, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { CHAT_MAX_CHARS } from '../lib/protocol'
import { cx } from '../lib/toast'
import type { ChatLine } from '../realtime/connection'

const SYSTEM_TEXT = {
  joined: (name: string) => `${name} joined the room!`,
  left: (name: string) => `${name} left the room!`,
  guessed: (name: string) => `${name} guessed the word!`,
  game_started: () => 'The game has started!',
  host_changed: (name: string) => `${name} is now the room owner!`,
}

function Line({ line, odd }: { line: ChatLine; odd: boolean }) {
  const base = cx('px-2 py-[3px] break-words', odd ? 'bg-panel-alt' : 'bg-white')
  if (line.kind === 'player') {
    return (
      <li className={base}>
        <b className="font-extrabold">{line.name}:</b> <span className="font-semibold">{line.text}</span>
      </li>
    )
  }
  if (line.kind === 'system') {
    const name = line.name ?? 'Someone'
    const text = SYSTEM_TEXT[line.event](name)
    return (
      <li
        className={cx(
          base,
          'font-extrabold',
          line.event === 'guessed' && 'bg-guessed/70! text-guessed-ink',
          line.event === 'joined' && 'text-guessed-ink',
          line.event === 'left' && 'text-leave',
          (line.event === 'game_started' || line.event === 'host_changed') && 'text-drawing',
        )}
      >
        {text}
      </li>
    )
  }
  return (
    <li
      className={cx(
        base,
        'font-extrabold',
        line.tone === 'close' && 'text-close',
        line.tone === 'error' && 'text-danger',
        line.tone === 'info' && 'text-muted',
        line.tone === 'draw' && 'text-drawing',
        line.tone === 'success' && 'text-guessed-ink',
      )}
    >
      {line.text}
    </li>
  )
}

interface ChatProps {
  lines: ChatLine[]
  onSend: (text: string) => Promise<unknown>
  /** When set, the input is disabled and shows this reason. */
  lockedReason: string | null
  placeholder: string
}

export const Chat = memo(function Chat({ lines, onSend, lockedReason, placeholder }: ChatProps) {
  const [text, setText] = useState('')
  const listRef = useRef<HTMLOListElement>(null)
  const stickToBottom = useRef(true)

  // Follow new messages unless the player scrolled up to read history.
  useLayoutEffect(() => {
    const list = listRef.current
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight
  }, [lines])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const message = text.trim()
    if (!message || lockedReason) return
    setText('')
    stickToBottom.current = true
    void onSend(message)
  }

  return (
    <section className="area-chat panel flex min-h-0 flex-col overflow-hidden" aria-label="Chat">
      <div className="relative min-h-0 flex-1">
        <ol
          ref={listRef}
          role="log"
          aria-live="polite"
          className="scroll-thin absolute inset-0 overflow-y-auto text-[0.82rem] sm:text-sm"
          onScroll={(e) => {
            const el = e.currentTarget
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }}
        >
          {lines.map((line, i) => (
            <Line key={line.kind === 'local' ? line.id : `m${line.id}`} line={line} odd={i % 2 === 1} />
          ))}
        </ol>
      </div>
      <form onSubmit={submit} className="border-t-2 border-line p-1.5">
        <label htmlFor="chat-input" className="sr-only">
          Guess or chat
        </label>
        <div className="relative">
          <input
            id="chat-input"
            className="field py-2 pr-11 text-sm"
            placeholder={lockedReason ?? placeholder}
            disabled={lockedReason !== null}
            value={lockedReason ? '' : text}
            maxLength={CHAT_MAX_CHARS}
            autoComplete="off"
            enterKeyHint="send"
            onChange={(e) => setText(e.target.value)}
          />
          {text.length > CHAT_MAX_CHARS - 50 && (
            <span className="absolute top-1/2 right-2 -translate-y-1/2 text-xs font-bold text-muted">
              {CHAT_MAX_CHARS - text.length}
            </span>
          )}
        </div>
      </form>
    </section>
  )
})
