import { memo, type ReactElement } from 'react'
import type { Avatar as AvatarParts } from '../lib/protocol'
import { AVATAR_COLORS } from './avatarParts'


const INK = '#1b1b1f'

const EYES: Array<() => ReactElement> = [
  // 0 classic
  () => (
    <>
      <circle cx="36" cy="42" r="9" fill="#fff" stroke={INK} strokeWidth="3" />
      <circle cx="64" cy="42" r="9" fill="#fff" stroke={INK} strokeWidth="3" />
      <circle cx="38" cy="43" r="4.5" fill={INK} />
      <circle cx="66" cy="43" r="4.5" fill={INK} />
    </>
  ),
  // 1 happy
  () => (
    <path d="M27 45q9-11 18 0M55 45q9-11 18 0" fill="none" stroke={INK} strokeWidth="4.5" strokeLinecap="round" />
  ),
  // 2 big shiny
  () => (
    <>
      <circle cx="35" cy="42" r="11" fill="#fff" stroke={INK} strokeWidth="3" />
      <circle cx="65" cy="42" r="11" fill="#fff" stroke={INK} strokeWidth="3" />
      <circle cx="36" cy="44" r="6.5" fill={INK} />
      <circle cx="66" cy="44" r="6.5" fill={INK} />
      <circle cx="38.5" cy="41" r="2.2" fill="#fff" />
      <circle cx="68.5" cy="41" r="2.2" fill="#fff" />
    </>
  ),
  // 3 sleepy
  () => (
    <>
      <path d="M27 42h18M55 42h18" stroke={INK} strokeWidth="4.5" strokeLinecap="round" />
      <path d="M29 43q7 6 14 0M57 43q7 6 14 0" fill="none" stroke={INK} strokeWidth="3" strokeLinecap="round" />
    </>
  ),
  // 4 grumpy
  () => (
    <>
      <circle cx="36" cy="45" r="8" fill="#fff" stroke={INK} strokeWidth="3" />
      <circle cx="64" cy="45" r="8" fill="#fff" stroke={INK} strokeWidth="3" />
      <circle cx="37" cy="46" r="4" fill={INK} />
      <circle cx="63" cy="46" r="4" fill={INK} />
      <path d="M26 32l18 6M74 32l-18 6" stroke={INK} strokeWidth="4.5" strokeLinecap="round" />
    </>
  ),
  // 5 wink
  () => (
    <>
      <circle cx="36" cy="42" r="9" fill="#fff" stroke={INK} strokeWidth="3" />
      <circle cx="37" cy="43" r="4.5" fill={INK} />
      <path d="M55 44q9-10 18 0" fill="none" stroke={INK} strokeWidth="4.5" strokeLinecap="round" />
    </>
  ),
  // 6 starry
  () => (
    <g fill="#ffe14d" stroke={INK} strokeWidth="2.5" strokeLinejoin="round">
      <path d="M36 31l3.5 7.5 8 1-6 5.5 1.6 8-7.1-4-7.1 4 1.6-8-6-5.5 8-1z" />
      <path d="M64 31l3.5 7.5 8 1-6 5.5 1.6 8-7.1-4-7.1 4 1.6-8-6-5.5 8-1z" />
    </g>
  ),
  // 7 dots
  () => (
    <>
      <circle cx="37" cy="42" r="5" fill={INK} />
      <circle cx="63" cy="42" r="5" fill={INK} />
    </>
  ),
  // 8 glasses
  () => (
    <>
      <circle cx="35" cy="42" r="11" fill="#e8f4ff" stroke={INK} strokeWidth="3.5" />
      <circle cx="65" cy="42" r="11" fill="#e8f4ff" stroke={INK} strokeWidth="3.5" />
      <path d="M46 42h8" stroke={INK} strokeWidth="3.5" />
      <circle cx="36" cy="43" r="4" fill={INK} />
      <circle cx="66" cy="43" r="4" fill={INK} />
    </>
  ),
  // 9 dizzy
  () => (
    <path d="M29 35l14 14M43 35L29 49M57 35l14 14M71 35L57 49" stroke={INK} strokeWidth="4.5" strokeLinecap="round" />
  ),
  // 10 side glance
  () => (
    <>
      <circle cx="36" cy="42" r="9" fill="#fff" stroke={INK} strokeWidth="3" />
      <circle cx="64" cy="42" r="9" fill="#fff" stroke={INK} strokeWidth="3" />
      <circle cx="41" cy="42" r="4.5" fill={INK} />
      <circle cx="69" cy="42" r="4.5" fill={INK} />
    </>
  ),
  // 11 surprised
  () => (
    <>
      <circle cx="35" cy="41" r="10" fill="#fff" stroke={INK} strokeWidth="3" />
      <circle cx="65" cy="41" r="10" fill="#fff" stroke={INK} strokeWidth="3" />
      <circle cx="35" cy="41" r="3" fill={INK} />
      <circle cx="65" cy="41" r="3" fill={INK} />
    </>
  ),
]

const MOUTHS: Array<() => ReactElement> = [
  () => <path d="M36 63q14 14 28 0" fill="none" stroke={INK} strokeWidth="4.5" strokeLinecap="round" />,
  () => (
    <>
      <path d="M34 61h32q-2 18-16 18t-16-18z" fill="#7a1022" stroke={INK} strokeWidth="3.5" strokeLinejoin="round" />
      <path d="M42 73q8-6 16 0q-8 5-16 0z" fill="#ff7b9c" />
    </>
  ),
  () => <path d="M39 68h22" stroke={INK} strokeWidth="4.5" strokeLinecap="round" />,
  () => <ellipse cx="50" cy="68" rx="6" ry="7" fill="#7a1022" stroke={INK} strokeWidth="3.5" />,
  () => (
    <>
      <path d="M36 63q14 13 28 0" fill="none" stroke={INK} strokeWidth="4.5" strokeLinecap="round" />
      <path d="M52 69q1 10 7 9t3-11" fill="#ff7b9c" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
    </>
  ),
  () => (
    <>
      <rect x="35" y="61" width="30" height="13" rx="5" fill="#fff" stroke={INK} strokeWidth="3.5" />
      <path d="M45 61v13M55 61v13M35 67.5h30" stroke={INK} strokeWidth="2" />
    </>
  ),
  () => <path d="M37 72q13-12 26 0" fill="none" stroke={INK} strokeWidth="4.5" strokeLinecap="round" />,
  () => <path d="M38 68q14 7 25-6" fill="none" stroke={INK} strokeWidth="4.5" strokeLinecap="round" />,
  () => <path d="M37 64q6.5 9 13 0q6.5 9 13 0" fill="none" stroke={INK} strokeWidth="4" strokeLinecap="round" />,
  () => (
    <path d="M34 68l5.3-4 5.3 4 5.3-4 5.3 4 5.3-4 5.3 4" fill="none" stroke={INK} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
  ),
  () => <path d="M33 61h34q0 19-17 19t-17-19z" fill="#7a1022" stroke={INK} strokeWidth="3.5" strokeLinejoin="round" />,
  () => <path d="M43 66q7 7 14 0" fill="none" stroke={INK} strokeWidth="4" strokeLinecap="round" />,
]


interface AvatarProps {
  avatar: AvatarParts
  size?: number
  className?: string
  /** Decorations drawn on top: host crown, drawer pencil. */
  crown?: boolean
  pencil?: boolean
  label?: string
}

export const Avatar = memo(function Avatar({ avatar, size = 48, className, crown, pencil, label }: AvatarProps) {
  const [c, e, m] = avatar
  const color = AVATAR_COLORS[c % AVATAR_COLORS.length]
  const Eyes = EYES[e % EYES.length]!
  const Mouth = MOUTHS[m % MOUTHS.length]!
  return (
    <svg
      viewBox="0 0 100 100"
      overflow="visible"
      width={size}
      height={size}
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path
        d="M50 9c27 0 41 19 41 43 0 25-17 40-41 40S9 77 9 52C9 28 23 9 50 9z"
        fill={color}
        stroke={INK}
        strokeWidth="4.5"
      />
      <ellipse cx="33" cy="25" rx="10" ry="6" fill="#fff" opacity="0.35" transform="rotate(-25 33 25)" />
      <Eyes />
      <Mouth />
      {crown && (
        <path
          d="M30 14l7-12 13 9 13-9 7 12-6 8H36z"
          fill="#ffcc1f"
          stroke={INK}
          strokeWidth="3.5"
          strokeLinejoin="round"
          transform="translate(0 -4) rotate(-12 50 12)"
        />
      )}
      {pencil && (
        <g transform="translate(64 58) rotate(35)">
          <rect x="0" y="0" width="12" height="34" rx="2" fill="#ffcc1f" stroke={INK} strokeWidth="3" />
          <path d="M0 34l6 10 6-10z" fill="#f5d0a0" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
        </g>
      )}
    </svg>
  )
})
