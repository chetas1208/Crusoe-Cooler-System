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
  build: {
    // 3D is an enhancement (V10): keep three / R3F / drei in their own chunks that only the lazily imported viewer pulls in, so the shell chunk never preloads them
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 40 },
            { name: 'three', test: /node_modules[\\/]three[\\/]/, priority: 30 },
          ],
        },
      },
    },
  },
  resolve: { dedupe: ['react', 'react-dom', 'three', '@react-three/fiber'] },
  optimizeDeps: { exclude: ['@loopkeeper/core', '@loopkeeper/scene'] },
});
