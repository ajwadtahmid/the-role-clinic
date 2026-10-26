import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number.parseInt(process.env.WEB_PORT ?? '5173', 10),
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${process.env.PORT ?? '3000'}`, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
})
