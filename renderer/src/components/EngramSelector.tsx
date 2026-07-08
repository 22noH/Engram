import { useEffect, useRef, useState } from 'react';
import type { Connection } from '../connections';
import { T } from '../i18n';

// 입력창 하단 오른쪽(보내기 버튼 옆) 칩 — Claude Code류 모델 선택기 스타일.
// 클릭 → 드롭다운(연결별 상태점·기본엔 ✓, 구분선, "Manage Engrams…"). XSS: 이름은 React 텍스트로만 렌더.
export function EngramSelector(props: {
  connections: Connection[];
  defaultConnId: string;
  statusById: Record<string, boolean>;
  onSetDefault: (id: string) => void;
  onManage: () => void;
}) {
  const { connections, defaultConnId, statusById, onSetDefault, onManage } = props;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = connections.find((c) => c.id === defaultConnId);

  // 바깥 클릭·Esc로 닫힘(Channels.tsx 팝오버 패턴과 동일).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div id="engramSelector" ref={ref}>
      <button type="button" className="chip" onClick={() => setOpen((o) => !o)}>
        <span className={'dot' + (statusById[defaultConnId] ? ' on' : '')} />
        {current?.name ?? T.engrams} ▾
      </button>
      {open && (
        <div id="engramMenu">
          {connections.map((c) => (
            <div key={c.id} className={'item' + (c.id === defaultConnId ? ' sel' : '')}
              onClick={() => { onSetDefault(c.id); setOpen(false); }}>
              <span className={'dot' + (statusById[c.id] ? ' on' : '')} />
              <span className="name">{c.name}</span>
              {c.id === defaultConnId && <span className="check">✓</span>}
            </div>
          ))}
          <div className="sep" />
          <div className="item manage" onClick={() => { onManage(); setOpen(false); }}>{T.manageEngrams}</div>
        </div>
      )}
    </div>
  );
}
