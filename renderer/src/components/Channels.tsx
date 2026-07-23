import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Channel } from '../../../shared/protocol';
import { T } from '../i18n';
import { TEAM_CHAT } from '../config';
import { areaTabs } from '../areas';

// chat.html의 #modetabs + #channels + #newch + 채널 ⋯메뉴(모드전환/삭제)를 컴포넌트로 이전.
export function Channels(props: {
  channels: Channel[];
  current: string | null;
  mode: 'chat' | 'code' | 'team' | 'wiki' | 'admin';
  canManageChannels: boolean;
  myId?: string;
  onSelect: (id: string) => void;
  onSetMode: (m: 'chat' | 'code' | 'team' | 'wiki' | 'admin') => void;
  onCreate: (name: string, mode: 'chat' | 'code' | 'team' | 'wiki' | 'admin', visibility?: 'public' | 'private') => void;
  onDelete: (id: string) => void;
  onSetRespondMode: (id: string, mode: 'all' | 'mention') => void;
  onManageMembers: (id: string) => void;
  showAdmin?: boolean;
  // Task 4 — 채널별 두뇌: 등록된 이름 목록(드롭다운 채우기용)과 선택 콜백. 기존 컴포넌트를
  // 쓰는 자리(테스트 등)를 깨지 않게 optional — 미전달 시 드롭다운은 "기본"만 보인다.
  brainNames?: string[];
  onSetChannelBrain?: (id: string, brain: string | null) => void;
  // Task 4(리뷰 지적) — 현재 기본 두뇌 이름. 있으면 드롭다운 기본 항목이 "Default (claude)" 형태로
  // 표시(스펙 §3.4). 미전달·빈 문자열이면 안전 폴백으로 기존처럼 "Default"만.
  defaultBrain?: string;
  // Task 4(clear-compact) — ⋯메뉴 정리 항목 2개(목업 ②). 슬래시 팔레트(/clear·/compact)와 동일 콜백.
  // onSetChannelBrain과 같은 결로 optional — 항목은 항상 렌더되고, 미전달 시 클릭이 no-op(기존 테스트 안 깨짐).
  onClearHistory?: (id: string) => void;
  onCompact?: (id: string) => void;
}) {
  const { channels, current, mode } = props;
  const [creating, setCreating] = useState(false);
  const [newPrivate, setNewPrivate] = useState(false);
  // 팝오버: 열린 채널 id + ⋯ 앵커 좌표(rect.left/bottom). 실제 화면 좌표는 렌더 후 실측해서 pos에.
  const [menu, setMenu] = useState<{ id: string; ax: number; ay: number } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });
  const popRef = useRef<HTMLDivElement>(null);
  const visible = channels.filter((c) => (c.mode || 'chat') === mode);
  // Phase 16b: ⋯메뉴(삭제·응답모드)는 channels.manage 권한 또는 채널 소유자(creatorId===myId)에게만.
  // Phase 16c: 비공개 채널은 감시 방지를 위해 주인(creatorId===myId)에게만 ⋯메뉴를 준다(서버 canAdminChannel 미러).
  const canManage = (c: Channel) => c.visibility === 'private'
    ? (!!props.myId && c.creatorId === props.myId)
    : (props.canManageChannels || (!!props.myId && c.creatorId === props.myId));
  const label: Record<'chat' | 'code' | 'team' | 'wiki' | 'admin', string> = { chat: T.tabAsk, team: T.tabTeam, code: T.tabCode, wiki: T.tabWiki, admin: T.tabAdmin };
  const tabs = areaTabs(TEAM_CHAT, props.showAdmin);

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
        {tabs.map((t) => (
          // Task 2 — Wiki 탭만 세리프 이탤릭(지식 표면 시그니처). 순수 스타일 클래스 추가, 핸들러·라벨 무변경.
          <div key={t} className={'mtab' + (t === mode ? ' sel' : '') + (t === 'wiki' ? ' wikiTab' : '')} onClick={() => props.onSetMode(t)}>
            {label[t]}
          </div>
        ))}
      </div>
      {mode === 'wiki' && (
        // 목업(2026-07-19) 레이아웃 픽스: 위키 사이드바(세그먼트+검색+목록)는 WikiArea가 여기로
        // 포털해 넣는다(#side=모드탭 아래 단일 컬럼) — WikiArea.tsx의 sideSlot 참고.
        // Task 2 — 눈썹 라벨(순수 프레젠테이션, 포털 대상 앞 형제 요소라 포털된 DOM 구조엔 영향 없음).
        <>
          <div className="eyebrow sideEyebrow">{T.sideKnowledge}</div>
          <div id="wikiSideSlot" />
        </>
      )}
      {mode !== 'wiki' && mode !== 'admin' && (
        <>
          <div className="eyebrow sideEyebrow">{T.sideChannels}</div>
          <div id="channels">
            {visible.map((c) => (
              <div key={c.id} className={'ch' + (c.id === current ? ' sel' : '')} onClick={() => props.onSelect(c.id)}>
                <span>{'# ' + c.name}</span>
                {c.visibility === 'private' && <span className="lock" title={T.channelPrivate} aria-label={T.channelPrivate}>🔒</span>}
                {c.brain && <span className="brainBadge" title={T.brain}>{c.brain}</span>}
                {canManage(c) && <span className="menu" onClick={(e) => { e.stopPropagation(); openMenu(c.id, e.currentTarget); }}>⋯</span>}
              </div>
            ))}
          </div>
        </>
      )}
      {menu && (() => {
        const c = channels.find((x) => x.id === menu.id);
        if (!c) return null;
        return (
          <div id="popmenu" ref={popRef} style={{ left: pos.left, top: pos.top }}>
            <div onClick={() => { props.onSetRespondMode(c.id, c.respondMode === 'all' ? 'mention' : 'all'); setMenu(null); }}>
              {c.respondMode === 'all' ? T.modeMention : T.modeAll}
            </div>
            <div onClick={() => { setMenu(null); props.onManageMembers(c.id); }}>
              {T.manageMembers}
            </div>
            <div className="popLabel">{T.brain}</div>
            <div className={!c.brain ? 'sel' : undefined} onClick={() => { setMenu(null); props.onSetChannelBrain?.(c.id, null); }}>
              {T.brainDefault(props.defaultBrain)}
            </div>
            {(props.brainNames ?? []).map((name) => (
              <div key={name} className={c.brain === name ? 'sel' : undefined} onClick={() => { setMenu(null); props.onSetChannelBrain?.(c.id, name); }}>
                {name}
              </div>
            ))}
            <div className="sep" />
            <div onClick={() => { setMenu(null); props.onCompact?.(c.id); }}>
              {T.compactMenu} <span className="hint">(/compact)</span>
            </div>
            <div className="danger" onClick={() => { setMenu(null); props.onClearHistory?.(c.id); }}>
              {T.clearMenu} <span className="hint">(/clear)</span>
            </div>
            <div className="sep" />
            <div className="danger" onClick={() => { setMenu(null); if (window.confirm(T.delConfirm(c.name))) props.onDelete(c.id); }}>
              {T.delChannel}
            </div>
          </div>
        );
      })()}
      {mode !== 'wiki' && mode !== 'admin' && (
        <div id="newch">
          {creating ? (
            <>
              <input
                autoFocus
                type="text"
                placeholder={mode === 'code' ? T.newCodeChannelPrompt : T.newChannelPrompt}
                onKeyDown={(e) => {
                  const v = (e.target as HTMLInputElement).value;
                  if (e.key === 'Enter' && v.trim()) { props.onCreate(v, mode, newPrivate ? 'private' : undefined); setCreating(false); setNewPrivate(false); }
                  else if (e.key === 'Escape') { setCreating(false); setNewPrivate(false); }
                }}
                onBlur={() => { setCreating(false); setNewPrivate(false); }}
              />
              <label className="privToggle" onMouseDown={(e) => e.preventDefault()}>
                <input type="checkbox" checked={newPrivate} onChange={(e) => setNewPrivate(e.target.checked)} />
                {T.newChannelPrivate}
              </label>
            </>
          ) : (
            <span onClick={() => setCreating(true)}>{T.newChannel}</span>
          )}
        </div>
      )}
    </div>
  );
}
