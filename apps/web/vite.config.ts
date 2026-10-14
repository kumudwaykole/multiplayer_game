import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// The API and Socket.IO are proxied so the browser sees one origin
// (http://localhost:5173), the same way Nginx serves them in production.
const api = 'http://127.0.0.1:3000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Unit tests live next to the code; Playwright specs in e2e/ run separately.
  test: { include: ['src/**/*.test.ts'] },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: api },
      '/socket.io': { target: api, ws: true },
    },
  },
})
