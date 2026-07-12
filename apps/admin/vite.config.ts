import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // Proxy the operator API so the SPA can call /admin/* on the same origin.
    proxy: {
      '/admin': 'http://localhost:4000',
    },
  },
})
