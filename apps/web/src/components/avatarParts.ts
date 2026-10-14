import type { Avatar } from '../lib/protocol'

export const AVATAR_COLORS = [
  '#ff5d5d', '#ff8a3d', '#ffc23d', '#ffe14d', '#8bd84b', '#3ccf7a', '#2ec4b6', '#3fa7ff', '#4f7cff',
  '#8b6cff', '#c264ff', '#ff6ad5', '#ff9fb2', '#b8d8ff', '#a5f0c5', '#d7b98e', '#9c7b5a', '#c0c4d6',
] as const

/** Must match the number of eye and mouth designs in Avatar.tsx. */
export const AVATAR_PARTS = { colors: AVATAR_COLORS.length, eyes: 12, mouths: 12 } as const

export function randomAvatar(): Avatar {
  const pick = (n: number) => Math.floor(Math.random() * n)
  return [pick(AVATAR_PARTS.colors), pick(AVATAR_PARTS.eyes), pick(AVATAR_PARTS.mouths)]
}
