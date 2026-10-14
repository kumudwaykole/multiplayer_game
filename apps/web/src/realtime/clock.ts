/**
 * Estimates server time from ping samples. The sample with the lowest
 * round trip wins, since it bounds the error best. Deadlines from the server
 * are wall-clock ms; the countdown shows `deadline - serverNow()`.
 */
export class ServerClock {
  private offset = 0
  private bestRtt = Number.POSITIVE_INFINITY
  private samples = 0

  /** t0/t1 are local Date.now() before and after; serverNow is from the ack. */
  addSample(t0: number, t1: number, serverNow: number): void {
    const rtt = t1 - t0
    this.samples++
    // Old samples age out slowly so a long session still follows drift.
    this.bestRtt = Math.min(this.bestRtt * 1.05, this.bestRtt + 5)
    if (rtt <= this.bestRtt) {
      this.bestRtt = rtt
      this.offset = serverNow - (t0 + t1) / 2
    }
  }

  /** Rough offset from a snapshot, used until the first ping returns. */
  seed(serverNow: number): void {
    if (this.samples === 0) this.offset = serverNow - Date.now()
  }

  now(): number {
    return Date.now() + this.offset
  }
}
