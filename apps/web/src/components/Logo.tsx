import { memo } from 'react'
import { cx } from '../lib/toast'

const COLORS = ['#ff5d5d', '#ff9a3d', '#ffe14d', '#53e237', '#3fd0ff', '#4f7cff', '#c264ff', '#ff6ad5']

/** Multicoloured, outlined wordmark. */
export const Logo = memo(function Logo({ size = 'lg' }: { size?: 'sm' | 'lg' }) {
  const words = ['Doodle', 'Dash']
  let i = 0
  return (
    <h1
      className={cx(
        'flex select-none flex-wrap items-baseline justify-center gap-x-[0.35em] tracking-wide',
        size === 'lg' ? 'text-[clamp(2.6rem,1.6rem+5vw,4.6rem)]' : 'text-[1.7rem]',
      )}
      aria-label="Doodle Dash"
    >
      {words.map((word, w) => (
        <span key={word} aria-hidden="true" className="whitespace-nowrap">
          {[...word].map((ch) => {
            const color = COLORS[i++ % COLORS.length]
            const tilt = ((i * 37) % 9) - 4
            return (
              <span key={i} className="logo-letter" style={{ color, transform: `rotate(${tilt}deg)` }}>
                {ch}
              </span>
            )
          })}
          {w === words.length - 1 && <span className="logo-letter text-[#ffcc1f]">!</span>}
        </span>
      ))}
    </h1>
  )
})
