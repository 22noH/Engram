import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
// Quiet Library — 폰트 번들(로컬, OFL). 런타임 네트워크 요청 없음(self-hosted woff2). 콘솔은 세리프 미사용.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import './theme.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
