import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The API and Socket.IO are proxied so the browser sees one origin
// (http://localhost:5173), the same way Nginx serves them in production.
const api = 'http://127.0.0.1:3000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: api },
      '/socket.io': { target: api, ws: true },
    },
  },
})
