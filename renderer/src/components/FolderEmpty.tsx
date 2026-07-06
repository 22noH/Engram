import { useState } from 'react';
import { T } from '../i18n';

// Code 채널 첫 진입(폴더 미바인딩) empty state. 네이티브 대화상자 우선, 브라우저는 텍스트 폴백.
export function FolderEmpty({ onSetRepo }: { onSetRepo: (path: string) => void }) {
  const [fallback, setFallback] = useState(false);
  const [val, setVal] = useState('');
  const pick = async () => {
    if (window.engramDesktop?.pickFolder) {
      const p = await window.engramDesktop.pickFolder();
      if (p) onSetRepo(p);
    } else {
      setFallback(true);
    }
  };
  return (
    <div id="empty">
      <div>{T.pickFolder}</div>
      <button onClick={pick}>{T.pickFolderBtn}</button>
      {fallback && (
        <input autoFocus type="text" placeholder={T.pickFolderPath} value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && val.trim()) onSetRepo(val.trim()); }} />
      )}
    </div>
  );
}
