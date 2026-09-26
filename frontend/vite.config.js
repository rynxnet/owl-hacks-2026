import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, /api and /ws are forwarded to the backend so the browser only talks to one origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
});
