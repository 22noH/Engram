import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Channel } from '../../../shared/protocol';
import { T } from '../i18n';

// chat.html의 #modetabs + #channels + #newch + 채널 ⋯메뉴(모드전환/삭제)를 컴포넌트로 이전.
export function Channels(props: {
  channels: Channel[];
  current: string | null;
  mode: 'chat' | 'code';
  onSelect: (id: string) => void;
  onSetMode: (m: 'chat' | 'code') => void;
  onCreate: (name: string, mode: 'chat' | 'code') => void;
  onDelete: (id: string) => void;
  onSetRespondMode: (id: string, mode: 'all' | 'mention') => void;
}) {
  const { channels, current, mode } = props;
  const [creating, setCreating] = useState(false);
  // 팝오버: 열린 채널 id + ⋯ 앵커 좌표(rect.left/bottom). 실제 화면 좌표는 렌더 후 실측해서 pos에.
  const [menu, setMenu] = useState<{ id: string; ax: number; ay: number } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });
  const popRef = useRef<HTMLDivElement>(null);
  const visible = channels.filter((c) => (c.mode || 'chat') === mode);

  // 바깥 클릭·Esc로 닫힘(chat.html document click/keydown 리스너 이전).
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => { if (!popRef.current?.contains(e.target as Node)) setMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menu]);

  // ⋯ 클릭 = 앵커 rect만 저장(측정 전 화면 밖으로 두어 깜빡임 방지).
  const openMenu = (id: string, anchor: HTMLElement) => {
    const r = anchor.getBoundingClientRect();
    setMenu({ id, ax: r.left, ay: r.bottom });
    setPos({ left: -9999, top: -9999 });
  };

  // 렌더 직후 팝오버 실측(offsetWidth/offsetHeight)으로 뷰포트 클램프(chat.html 그대로, paint 전 배치).
  useLayoutEffect(() => {
    if (!menu || !popRef.current) return;
    const w = popRef.current.offsetWidth, h = popRef.current.offsetHeight;
    setPos({
      left: Math.max(8, Math.min(menu.ax, window.innerWidth - w - 8)),
      top: Math.min(menu.ay + 4, window.innerHeight - h - 8),
    });
  }, [menu]);

  return (
    <div id="side">
      <div id="modetabs">
        {(['chat', 'code'] as const).map((m) => (
          <div key={m} className={'mtab' + (m === mode ? ' sel' : '')} onClick={() => props.onSetMode(m)}>
            {m === 'chat' ? T.tabAsk : T.tabCode}
          </div>
        ))}
      </div>
      <div id="channels">
        {visible.map((c) => (
          <div key={c.id} className={'ch' + (c.id === current ? ' sel' : '')} onClick={() => props.onSelect(c.id)}>
            <span>{'# ' + c.name}</span>
            <span className="menu" onClick={(e) => { e.stopPropagation(); openMenu(c.id, e.currentTarget); }}>⋯</span>
          </div>
        ))}
      </div>
      {menu && (() => {
        const c = channels.find((x) => x.id === menu.id);
        if (!c) return null;
        return (
          <div id="popmenu" ref={popRef} style={{ left: pos.left, top: pos.top }}>
            <div onClick={() => { props.onSetRespondMode(c.id, c.respondMode === 'all' ? 'mention' : 'all'); setMenu(null); }}>
              {c.respondMode === 'all' ? T.modeMention : T.modeAll}
            </div>
            <div className="danger" onClick={() => { setMenu(null); if (window.confirm(T.delConfirm(c.name))) props.onDelete(c.id); }}>
              {T.delChannel}
            </div>
          </div>
        );
      })()}
      <div id="newch">
        {creating ? (
          <input
            autoFocus
            type="text"
            placeholder={mode === 'code' ? T.newCodeChannelPrompt : T.newChannelPrompt}
            onKeyDown={(e) => {
              const v = (e.target as HTMLInputElement).value;
              if (e.key === 'Enter' && v.trim()) { props.onCreate(v, mode); setCreating(false); }
              else if (e.key === 'Escape') setCreating(false);
            }}
            onBlur={() => setCreating(false)}
          />
        ) : (
          <span onClick={() => setCreating(true)}>{T.newChannel}</span>
        )}
      </div>
    </div>
  );
}
