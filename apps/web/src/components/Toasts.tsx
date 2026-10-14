import { useStore } from '../lib/store'
import { cx, toastStore } from '../lib/toast'

export function Toasts() {
  const toasts = useStore(toastStore)
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx(
            'animate-rise rounded-xl px-4 py-2 font-extrabold text-white shadow-[0_4px_0_rgb(0_0_0/0.25)]',
            t.tone === 'success' && 'bg-play-dark',
            t.tone === 'error' && 'bg-danger',
            t.tone === 'info' && 'bg-ink',
          )}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}
