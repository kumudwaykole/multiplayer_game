import { useEffect } from 'react'
import { Toasts } from './components/Toasts'
import { parseRoute, usePathname } from './lib/router'
import { loadSession } from './lib/session'
import { HomePage } from './pages/HomePage'
import { RoomPage } from './pages/RoomPage'

export function App() {
  const route = parseRoute(usePathname())

  useEffect(() => {
    void loadSession()
  }, [])

  return (
    <>
      {route.name === 'room' ? <RoomPage key={route.code} code={route.code} /> : <HomePage />}
      <Toasts />
    </>
  )
}
