import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { offlineShell } from './pwa/build';

export default defineConfig(({ mode }) => ({
  plugins: [react(), offlineShell()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
  preview: {
    host: mode === 'https' ? '0.0.0.0' : '127.0.0.1', port: 4173, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8000' },
    https: mode === 'https' ? { key: readFileSync(new URL('../.certs/reader-key.pem', import.meta.url)), cert: readFileSync(new URL('../.certs/reader.pem', import.meta.url)) } : undefined,
    headers: { 'Cache-Control': 'no-cache' },
  },
}));
