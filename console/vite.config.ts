import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// T2가 임의 경로(/admin 등)에서 정적으로 서빙하므로 상대 경로 자산(base './') 필수 — renderer와 같은 이유.
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
