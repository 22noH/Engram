import { useCallback, useEffect, useState } from 'react';
import type { CreatePrResult, GitBranchStatus } from '../desktop';
import { T } from '../i18n';

// 코드 채널 상단 줄(B안, 사용자 선택) — 입력바 바로 위 별도 줄:
//   `⑂ <브랜치>  +<추가>  −<삭제>            [PR 생성]`
// 채널 헤더(#chhdr)는 기존대로 폴더명+패널 아이콘만 유지한다.
//
// 갱신은 이벤트 기반(마운트·refreshKey 변화=메시지 도착·창 포커스 복귀) — 과한 폴링을 하지 않는다.

// 실패 reason → 안내 문구(백엔드 git-pr.ts의 raw message는 영어 고정이라 로케일 문구로 갈아끼운다).
function prErrorText(reason: string): string {
  switch (reason) {
    case 'gh-missing': return T.prErrGhMissing;
    case 'gh-unauthenticated': return T.prErrGhAuth;
    case 'no-remote': return T.prErrNoRemote;
    case 'on-default-branch': return T.prErrDefaultBranch;
    case 'detached': return T.prErrDetached;
    case 'push-failed': return T.prErrPushFailed;
    case 'pr-failed': return T.prErrPrFailed;
    case 'not-repo': return T.codeDiffNotRepo;
    default: return T.prErrGeneric;
  }
}

export function GitBranchBar({ repoPath, refreshKey }: { repoPath: string; refreshKey?: number }) {
  const [status, setStatus] = useState<GitBranchStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [pr, setPr] = useState<{ url: string; alreadyExisted: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const fn = window.engramDesktop?.gitBranchStatus;
    if (!fn) return;
    let alive = true;
    void fn(repoPath).then((s) => { if (alive) setStatus(s); }, () => { if (alive) setStatus({ ok: false, reason: 'error' }); });
    return () => { alive = false; };
  }, [repoPath]);

  useEffect(() => { setPr(null); setError(null); }, [repoPath]);
  useEffect(() => load(), [load, refreshKey]);
  // 창 포커스 복귀 시 한 번 더(밖에서 커밋/브랜치 전환을 했을 수 있다).
  useEffect(() => {
    const onFocus = () => { load(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  if (!status) return null;
  if (!status.ok) {
    // 레포 아님/git 없음은 최소 안내만, 그 밖의 오류(error)는 줄 자체를 숨긴다.
    if (status.reason === 'error') return null;
    return (
      <div className="gitBranchBar">
        <span className="gitNotice">{status.reason === 'git-missing' ? T.codeDiffGitMissing : T.codeDiffNotRepo}</span>
      </div>
    );
  }

  // ⚠️ 이 버튼은 push + PR 생성(되돌리기 어려운 외부 동작)을 즉시 실행한다 — 확인 없이는 절대 진행하지 않는다.
  const createPr = () => {
    const fn = window.engramDesktop?.gitCreatePr;
    if (!fn || busy) return;
    if (!window.confirm(T.prConfirm(status.branch))) return;
    setBusy(true); setError(null); setPr(null);
    void fn(repoPath).then(
      (r: CreatePrResult) => {
        setBusy(false);
        if (r.ok) setPr({ url: r.url, alreadyExisted: r.alreadyExisted });
        else setError(prErrorText(r.reason));
      },
      () => { setBusy(false); setError(T.prErrGeneric); },
    );
  };

  return (
    <div className="gitBranchBar">
      <span className="gitBranch" title={status.detached ? T.gitDetached : T.gitBranchTitle}>
        {'⑂ ' + status.branch}
      </span>
      <span className="gitAdded" title={T.gitAddedTitle}>{`+${status.added}`}</span>
      <span className="gitRemoved" title={T.gitRemovedTitle}>{`−${status.removed}`}</span>
      {pr && (
        <span className="gitPrResult">
          {pr.alreadyExisted && <span className="gitNotice">{T.prAlreadyExists}</span>}
          <a href={pr.url} target="_blank" rel="noopener noreferrer">{T.prOpen}</a>
        </span>
      )}
      {error && <span className="gitPrError">{error}</span>}
      <button type="button" className="prBtn" disabled={busy} onClick={createPr}>
        {busy ? T.prCreating : T.prCreate}
      </button>
    </div>
  );
}
