import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind on all interfaces (IPv4 + IPv6) so localhost / 127.0.0.1 both resolve.
    host: true,
    // Proxy the customer API so the widget can call /api/* on the same origin.
    proxy: { '/api': 'http://localhost:4000' },
  },
})
