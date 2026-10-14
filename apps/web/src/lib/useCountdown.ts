import { useEffect, useState } from 'react'
import type { ServerClock } from '../realtime/clock'

/** Whole seconds left until a server-time deadline; re-renders only the caller, 4x a second. */
export function useCountdown(deadline: number | null, clock: ServerClock): number | null {
  const [, setTick] = useState(0)

  useEffect(() => {
    if (deadline === null) return
    const timer = setInterval(() => setTick((n) => n + 1), 250)
    return () => clearInterval(timer)
  }, [deadline])

  return deadline === null ? null : Math.max(0, Math.ceil((deadline - clock.now()) / 1000))
}
