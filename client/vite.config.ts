import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev proxy so the browser can call ESI without CORS pain.
// Calls to /esi/* will be forwarded to https://esi.evetech.net/*
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/esi': {
        target: 'https://esi.evetech.net',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/esi/, '')
      }
    }
  }
});
