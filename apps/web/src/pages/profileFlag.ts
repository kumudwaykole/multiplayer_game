/**
 * Set when the player confirmed their name and avatar on the home screen in
 * this page load, so the room page can skip asking again.
 */
let confirmed = false

export function markProfileConfirmed(): void {
  confirmed = true
}

export function isProfileConfirmed(): boolean {
  return confirmed
}
