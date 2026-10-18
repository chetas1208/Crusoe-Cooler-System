// Agent FF: vite for the demo recorder. :5233 -> API :8833 only.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const root = new URL('../../apps/web/', import.meta.url).pathname;
export default defineConfig({
  root,
  plugins: [react()],
  envDir: new URL('../../', import.meta.url).pathname,
  server: { port: 5233, host: '127.0.0.1', strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:8833', changeOrigin: true, ws: true } } },
  resolve: { dedupe: ['react', 'react-dom', 'three', '@react-three/fiber'] },
  optimizeDeps: { exclude: ['@loopkeeper/core', '@loopkeeper/scene'] },
});
