import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 渲染层在 renderer/，产物到 renderer/dist。base './' 让 file:// 加载时资源路径为相对。
export default defineConfig({
  root: 'renderer',
  base: './',
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
