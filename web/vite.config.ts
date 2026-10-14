import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Built into the Go server's embed folder, so the binary carries the site. In dev, the API and the Papertrade proxy are the Go server's.
export default defineConfig({
  plugins: [react()],
  build: { outDir: '../server/internal/webui/dist/app', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:8080', '/paper': 'http://localhost:8080' } },
})
