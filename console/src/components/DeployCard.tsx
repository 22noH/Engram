import { useState } from 'react';
import { T } from '../i18n';
import { fetchPresetBlob } from '../api';

// 목업 ⑨ 하단 "클라이언트 배포" 카드 — 서버설정 화면(⑨ 픽셀 그대로)과 별도 "클라이언트 배포"
// 네비 항목(목업 나머지 스크린엔 없는 신규 뷰 — report 참조) 양쪽에서 재사용한다(ponytail: 중복 금지).
// GET /admin/api/preset를 blob으로 받아 objectURL+임시 <a>.click()으로 브라우저 저장 대화상자를 띄운다.
export function DeployCard() {
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setBusy(true);
    const blob = await fetchPresetBlob();
    setBusy(false);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'preset.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="grp">
      <div className="deploy">
        <div className="d">
          <div className="t">{T.deployTitle}</div>
          <div className="s">{T.deploySub}</div>
        </div>
        <button disabled={busy} onClick={download}>{T.downloadPresetBtn}</button>
      </div>
    </div>
  );
}
