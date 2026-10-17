import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // one shared repo-root .env; Vite only exposes VITE_-prefixed vars to the browser
  envDir: '../..',
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  resolve: { dedupe: ['react', 'react-dom', 'three', '@react-three/fiber'] },
  optimizeDeps: { exclude: ['@loopkeeper/core', '@loopkeeper/scene'] },
});
