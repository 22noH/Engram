import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Electron이 file://로 로드하므로 상대 경로 자산(base './') 필수.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { fs: { allow: ['..'] } }, // ../shared 참조 허용
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/vitest.setup.ts',
  },
});
