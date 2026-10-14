import { Store } from './store'

export interface Toast {
  id: number
  text: string
  tone: 'info' | 'success' | 'error'
}

export const toastStore = new Store<Toast[]>([])
let nextId = 1

export function toast(text: string, tone: Toast['tone'] = 'info', ms = 2600): void {
  const id = nextId++
  toastStore.set((list) => [...list.slice(-3), { id, text, tone }])
  window.setTimeout(() => toastStore.set((list) => list.filter((t) => t.id !== id)), ms)
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
