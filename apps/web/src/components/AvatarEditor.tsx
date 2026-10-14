import type { Avatar as AvatarParts } from '../lib/protocol'
import { Avatar } from './Avatar'
import { AVATAR_PARTS, randomAvatar } from './avatarParts'

const PARTS = [
  { index: 1, label: 'eyes', count: AVATAR_PARTS.eyes },
  { index: 2, label: 'mouth', count: AVATAR_PARTS.mouths },
  { index: 0, label: 'colour', count: AVATAR_PARTS.colors },
] as const

function Arrow({ dir, label, onClick }: { dir: 'left' | 'right'; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="grid size-8 place-items-center rounded-full text-white transition hover:scale-110 hover:bg-white/15"
    >
      <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true">
        <path
          d={dir === 'left' ? 'M15 4l-8 8 8 8' : 'M9 4l8 8-8 8'}
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}

/** Avatar customiser: arrows for eyes, mouth and colour, plus a randomiser. */
export function AvatarEditor({ value, onChange }: { value: AvatarParts; onChange: (next: AvatarParts) => void }) {
  const step = (index: 0 | 1 | 2, count: number, delta: number) => {
    const next = [...value] as AvatarParts
    next[index] = (next[index] + delta + count) % count
    onChange(next)
  }
  return (
    <div className="relative flex items-center justify-center gap-1 rounded-xl bg-sky-deep px-2 py-3">
      <div className="flex flex-col gap-1">
        {PARTS.map((p) => (
          <Arrow key={p.label} dir="left" label={`Previous ${p.label}`} onClick={() => step(p.index, p.count, -1)} />
        ))}
      </div>
      <Avatar avatar={value} size={104} label="Your avatar" className="drop-shadow-[0_4px_0_rgb(0_0_0/0.25)]" />
      <div className="flex flex-col gap-1">
        {PARTS.map((p) => (
          <Arrow key={p.label} dir="right" label={`Next ${p.label}`} onClick={() => step(p.index, p.count, 1)} />
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange(randomAvatar())}
        className="absolute top-2 right-2 grid size-9 place-items-center rounded-lg bg-white/15 text-white transition hover:rotate-12 hover:bg-white/25"
        aria-label="Random avatar"
        title="Random avatar"
      >
        <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="4" fill="none" stroke="currentColor" strokeWidth="2.5" />
          <circle cx="8" cy="8" r="1.6" fill="currentColor" />
          <circle cx="16" cy="16" r="1.6" fill="currentColor" />
          <circle cx="12" cy="12" r="1.6" fill="currentColor" />
          <circle cx="16" cy="8" r="1.6" fill="currentColor" />
          <circle cx="8" cy="16" r="1.6" fill="currentColor" />
        </svg>
      </button>
    </div>
  )
}
