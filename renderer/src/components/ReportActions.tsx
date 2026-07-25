import { useState } from 'react';
import type { CreatePrResult } from '../desktop';
import { prErrorText } from './GitBranchBar';
import { T } from '../i18n';

// 완료 보고서 아래 액션 줄(목업 승인) — [변경점 보기] [PR 생성].
// 둘 다 이미 있는 기능을 그대로 부른다: 변경점=코드 독의 Diff 칸, PR=engram:git-create-pr.
// 채팅으로 문장을 보내는 게 아니라 앱 기능을 호출하므로 메시지의 actions로는 실을 수 없다.
export function ReportActions({ onShowDiff, repoPath }: { onShowDiff?: () => void; repoPath?: string }) {
  const [busy, setBusy] = useState(false);
  const [pr, setPr] = useState<{ url: string; alreadyExisted: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canPr = !!repoPath && !!window.engramDesktop?.gitCreatePr;
  if (!onShowDiff && !canPr) return null; // 데스크톱이 아니면 줄 자체를 안 그린다

  // ⚠️ push + PR 생성(되돌리기 어려운 외부 동작)이라 확인 대화를 반드시 거친다 — 상단 브랜치 줄과 같은 규칙.
  const createPr = async (): Promise<void> => {
    const fn = window.engramDesktop?.gitCreatePr;
    if (!fn || !repoPath || busy) return;
    let branch = '';
    try {
      const st = await window.engramDesktop?.gitBranchStatus?.(repoPath);
      if (st?.ok) branch = st.branch;
    } catch { /* 브랜치 이름은 확인 문구용일 뿐 — 못 구해도 확인은 그대로 띄운다 */ }
    if (!window.confirm(T.prConfirm(branch))) return;
    setBusy(true); setError(null); setPr(null);
    try {
      const r: CreatePrResult = await fn(repoPath);
      setBusy(false);
      if (r.ok) setPr({ url: r.url, alreadyExisted: r.alreadyExisted });
      else setError(prErrorText(r.reason));
    } catch { setBusy(false); setError(T.prErrGeneric); }
  };

  return (
    <div className="reportActions">
      {onShowDiff && <button type="button" onClick={onShowDiff}>{T.reportViewDiff}</button>}
      {canPr && (
        <button type="button" className="prBtn" disabled={busy} onClick={() => { void createPr(); }}>
          {busy ? T.prCreating : T.prCreate}
        </button>
      )}
      {pr && (
        <span className="gitPrResult">
          {pr.alreadyExisted && <span className="gitNotice">{T.prAlreadyExists}</span>}
          <a href={pr.url} target="_blank" rel="noopener noreferrer">{T.prOpen}</a>
        </span>
      )}
      {error && <span className="gitPrError">{error}</span>}
    </div>
  );
}
