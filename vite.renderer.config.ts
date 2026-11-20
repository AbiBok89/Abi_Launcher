import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: resolve(__dirname, 'dist-renderer'),
    emptyOutDir: true
  }
})
