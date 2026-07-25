import { useCallback, useEffect, useRef, useState } from 'react';
import { T } from '../../i18n';

// 독 패널 Diff 탭 — 기존 CodePanel의 DiffTab을 옮겨온 것(git-diff.ts 그대로, 읽기 전용).
// 달라진 점: 파일을 고르면 상위(탭)에 알려 탭 제목이 파일명이 되고, 저장된 파일을 다시 열 때
// 그 파일의 diff부터 보여준다(파일당 탭 — 스펙 §칸별 규칙).

type DiffFile = { path: string; status: 'A' | 'M' | 'D' | 'R' | '?' };

function diffReasonText(reason: string): string {
  if (reason === 'not-repo') return T.codeDiffNotRepo;
  if (reason === 'git-missing') return T.codeDiffGitMissing;
  return T.codeDiffLoadError;
}

function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) return 'dHunk';
  if (line.startsWith('+')) return 'dAdd';
  if (line.startsWith('-')) return 'dDel';
  return '';
}

export function DiffPane({ repoPath, file, onPickFile, onCount }: {
  repoPath: string;
  /** 이 탭이 보고 있는 파일(퍼시스트됨). 없으면 목록만. */
  file?: string;
  onPickFile: (path: string) => void;
  onCount?: (n: number) => void;
}) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [diffText, setDiffText] = useState<string | null>(null);
  // onCount를 의존성에 넣으면 부모의 인라인 화살표 때문에 매 렌더마다 refresh가 새로 만들어지고
  // effect가 다시 돌아 무한 갱신이 된다 — 콜백은 ref로 최신 것만 부른다(TerminalPane과 같은 규칙).
  const countRef = useRef(onCount);
  countRef.current = onCount;

  const refresh = useCallback(async () => {
    const api = window.engramDesktop;
    if (!api?.gitDiffStatus) return;
    const res = await api.gitDiffStatus(repoPath);
    if (res.ok) {
      setFiles(res.files);
      countRef.current?.(res.files.length);
      setNotice(null);
    } else {
      setFiles([]);
      countRef.current?.(0);
      setNotice(diffReasonText(res.reason));
    }
  }, [repoPath]);

  useEffect(() => { void refresh(); }, [refresh]);

  // 선택된 파일이 바뀌면(탭 복원 포함) 그 파일 diff를 읽는다.
  useEffect(() => {
    let cancelled = false;
    if (!file) { setDiffText(null); return; }
    setDiffText(null);
    void (async () => {
      const api = window.engramDesktop;
      if (!api?.gitDiffFile) return;
      const res = await api.gitDiffFile(repoPath, file);
      if (!cancelled) setDiffText(res.ok ? res.diff : T.codeDiffError);
    })();
    return () => { cancelled = true; };
  }, [repoPath, file]);

  return (
    <div className="codeDiff">
      <div className="codeDiffList">
        <button type="button" className="codeDiffRefresh" title={T.codeRefresh} onClick={() => void refresh()}>⟳</button>
        {notice && <div className="codeEmptyNotice">{notice}</div>}
        {files?.map((f) => (
          <div key={f.path} className={'codeDiffFile' + (file === f.path ? ' sel' : '')}
            onClick={() => onPickFile(f.path)}>
            <span className={'codeDiffStatus s' + f.status}>{f.status}</span>
            <span className="codeDiffPath">{f.path}</span>
          </div>
        ))}
        {files && files.length === 0 && !notice && <div className="codeEmptyNotice">{T.codeDiffNone}</div>}
      </div>
      <div className="codeDiffView">
        {diffText != null ? (
          <pre className="codeDiffPre">
            {diffText.split('\n').map((line, i) => (
              <div key={i} className={diffLineClass(line)}>{line || ' '}</div>
            ))}
          </pre>
        ) : (
          <div className="codeEmptyNotice">{T.codeDiffSelectFile}</div>
        )}
      </div>
    </div>
  );
}
