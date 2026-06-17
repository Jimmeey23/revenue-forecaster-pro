import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    port: 5000,
    strictPort: true,
    host: true,
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:4173'
    }
  },
  build: {
    outDir: 'dist'
  }
})
