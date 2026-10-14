import { useSyncExternalStore } from 'react'

/** Minimal external store. React subscribes with useStore; everything else reads `.get()`. */
export class Store<T> {
  private value: T
  private readonly listeners = new Set<() => void>()

  constructor(initial: T) {
    this.value = initial
  }

  get = (): T => this.value

  set(next: T | ((current: T) => T)): void {
    const value = typeof next === 'function' ? (next as (current: T) => T)(this.value) : next
    if (Object.is(value, this.value)) return
    this.value = value
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/** Subscribes to one slice so unrelated updates do not re-render the component. */
export function useStoreSelector<T, S>(store: Store<T>, select: (value: T) => S): S {
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.get()),
    () => select(store.get()),
  )
}
