import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      crypto: path.resolve(__dirname, './src/utils/crypto-fallback.js'),
    },
  },
  optimizeDeps: {
    exclude: ['@koush/wrtc', 'wrtc', 'ws'],
  },
  server: {
    port: 3000,
    host: true,
    open: true,
    allowedHosts: true,
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:8080',
        ws: true,
        changeOrigin: true,
      },
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: process.env.NODE_ENV === 'development',
    rollupOptions: {
      external: ['@koush/wrtc', 'wrtc', 'ws', 'crypto'],
    },
    rolldownOptions: {
      external: ['@koush/wrtc', 'wrtc', 'ws', 'crypto'],
    },
  },
});
