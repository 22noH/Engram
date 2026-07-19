import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// T2가 /admin/ 아래 고정 마운트로 정적 서빙하므로 base를 그 경로로 고정한다(S1 최종리뷰:
// base './'는 GET /admin(트레일링 슬래시 없이)에서 자산 URL이 사이트 루트로 잘못 풀려 404→빈
// 페이지가 됐다 — mount가 하드코딩이라 일반성 손실 없음. admin-http.ts의 무슬래시→302 리다이렉트와
// 세트[벨트+멜빵]).
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  server: { fs: { allow: ['..'] } }, // ../shared 참조 허용
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/vitest.setup.ts',
  },
});
