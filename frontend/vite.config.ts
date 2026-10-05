import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { 'invoice-rules': fileURLToPath(new URL('../shared/invoice-rules.cjs', import.meta.url)) } },
  optimizeDeps: { include: ['invoice-rules'], force: true },
  build: { commonjsOptions: { include: [/node_modules/, /shared\/.*\.cjs$/] } },
  server: {
    proxy: {
      '/invoice': 'http://localhost:3000',
      '/api': 'http://localhost:3000',
    },
  },
})
