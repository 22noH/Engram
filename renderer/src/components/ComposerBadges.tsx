import { useEffect, useRef, useState } from 'react';
import type { EffortLevel, PermMode } from '../../../shared/protocol';
import { T } from '../i18n';

// 입력바 2행의 배지 3종(목업 승인 2026-07-25) — 응답 모드 / 모델(채널 두뇌) / 노력.
// 셋 다 "칩 + 위로 뜨는 작은 팝오버"라는 같은 형태라 이 파일에 모아 두고 닫힘 처리를 공유한다
// (바깥 클릭·Esc — EngramSelector·Channels ⋯메뉴가 쓰는 기존 패턴과 동일).
// 프레임은 하나도 여기서 만들지 않는다: 부모(App)가 기존 fanoutToName으로 보낸다.

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  // close는 렌더마다 새 함수라 ref로 미러한다(리스너 재등록 방지 — 레포의 기존 ref 미러 이디엄).
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) closeRef.current(); };
    // 팝오버가 열려 있으면 Esc는 여기서 먹는다 — window 레벨 생성-중지 리스너까지 안 번지게
    // stopPropagation(팔레트의 Esc 처리와 같은 결).
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return ref;
}

// 응답 모드 배지 — 기존 채널 ⋯메뉴의 setRespondMode 전환을 입력바로 끌어올린 것(동작 동일).
export function RespondModeBadge({ mode, onChange }: {
  mode: 'all' | 'mention';
  onChange: (m: 'all' | 'mention') => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div className="cbadgeWrap" ref={ref}>
      <button type="button" className="cbadge respondBadge" title={T.respondModeTitle}
        onClick={() => setOpen((o) => !o)}>
        {mode === 'all' ? T.respondAuto : T.respondMention} ▾
      </button>
      {open && (
        <div className="cbadgeMenu">
          <div className={'item' + (mode === 'all' ? ' sel' : '')}
            onClick={() => { onChange('all'); setOpen(false); }}>{T.modeAll}</div>
          <div className={'item' + (mode === 'mention' ? ' sel' : '')}
            onClick={() => { onChange('mention'); setOpen(false); }}>{T.modeMention}</div>
        </div>
      )}
    </div>
  );
}

// 모델(채널 두뇌) 배지 — 채널 ⋯메뉴의 두뇌 목록과 같은 항목·같은 프레임(setChannelBrain).
// 라벨은 현재 선택된 이름(미설정이면 기본 두뇌 이름, 그것도 모르면 "기본").
export function ModelBadge({ brain, brainNames, defaultBrain, onChange }: {
  brain?: string;
  brainNames?: string[];
  defaultBrain?: string;
  onChange: (brain: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div className="cbadgeWrap" ref={ref}>
      <button type="button" className="cbadge modelBadge" title={T.brain}
        onClick={() => setOpen((o) => !o)}>
        {brain || defaultBrain || T.default} ▾
      </button>
      {open && (
        <div className="cbadgeMenu">
          <div className={'item' + (!brain ? ' sel' : '')}
            onClick={() => { onChange(null); setOpen(false); }}>{T.brainDefault(defaultBrain)}</div>
          {(brainNames ?? []).map((name) => (
            <div key={name} className={'item' + (brain === name ? ' sel' : '')}
              onClick={() => { onChange(name); setOpen(false); }}>{name}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// 권한 모드 — 코드 채널에서만 응답 모드 배지 자리를 대신한다(게이트는 App). 느슨해지는 순서로 나열하고
// 마지막 "권한 무시"만 구분선 아래 danger로 뗀다(목업 승인).
const PERM_MODES: PermMode[] = ['plan', 'files', 'restricted', 'auto'];

// 채널에 값이 없으면 서버가 전역 설정(permissions.json allow.commandMode)으로 폴백한다. 그래서 라벨은
// "채널값 → 전역 기본값(서버가 channels 프레임으로 알려준 defaultPermMode) → auto" 순으로 정한다.
// 마지막 'auto'는 전역값을 아예 모를 때(구식 서버·brain 모드)의 기존 표시 그대로(회귀 0).
export function PermModeBadge({ permMode, defaultPermMode, onChange }: {
  permMode?: PermMode;
  defaultPermMode?: PermMode;
  onChange: (m: PermMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  // 지금 이 채널에 실제로 적용되는 모드(라벨·드롭다운 체크가 둘 다 이 하나를 본다 — 서로 어긋날 수 없게).
  const effective: PermMode = permMode ?? defaultPermMode ?? 'auto';
  // 되돌리기 어려운 위험 설정(폴더 밖 수정 허용)은 확인 한 번을 거친다 — 거부하면 아무 일도 안 한다.
  const pick = (m: PermMode): void => {
    if (m === 'bypass' && !window.confirm(T.permBypassConfirm)) return;
    onChange(m);
    setOpen(false);
  };
  const item = (m: PermMode) => (
    <div key={m} className={'item permItem' + (effective === m ? ' sel' : '') + (m === 'bypass' ? ' danger' : '')}
      onClick={() => pick(m)}>
      <div className="permName">{T.permModeName(m)}</div>
      <div className="permDesc">{T.permModeDesc(m)}</div>
    </div>
  );
  return (
    <div className="cbadgeWrap" ref={ref}>
      <button type="button" className={'cbadge permBadge' + (effective === 'bypass' ? ' danger' : '')}
        title={T.permModeTitle} onClick={() => setOpen((o) => !o)}>
        {T.permModeName(effective)} ▾
      </button>
      {open && (
        <div className="cbadgeMenu permPop">
          <div className="permHead">{T.permModeHeader}</div>
          {PERM_MODES.map(item)}
          <div className="permSep" />
          {item('bypass')}
        </div>
      )}
    </div>
  );
}

// 노력(effort) 5단계 — shared/protocol.ts의 EffortLevel과 1:1, 낮음→최대 순서(슬라이더 좌→우).
export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// 노력 배지 — 코드 채널 전용(게이트는 App). 팝오버는 좌 "더 빠르게" ↔ 우 "더 스마트하게" 슬라이더.
// 미설정 채널은 부모가 'high'(서버 기본값)를 넘겨준다.
export function EffortBadge({ effort, onChange }: {
  effort: EffortLevel;
  onChange: (e: EffortLevel) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const idx = Math.max(0, EFFORT_LEVELS.indexOf(effort));
  // 낙관적 위치: 서버가 channels 프레임으로 새 값을 되돌려주기 전까지 손잡이가 제자리로 튀지 않게.
  const [pos, setPos] = useState(idx);
  useEffect(() => { setPos(idx); }, [idx]);
  return (
    <div className="cbadgeWrap" ref={ref}>
      <button type="button" className="cbadge effortBadge" title={T.effortTitle}
        onClick={() => setOpen((o) => !o)}>
        {T.effortLevel(effort)} ▾
      </button>
      {open && (
        <div className="cbadgeMenu effortPop">
          <div className="effortEnds">
            <span>{T.effortFaster}</span>
            <span>{T.effortSmarter}</span>
          </div>
          <input type="range" className="effortSlider" min={0} max={EFFORT_LEVELS.length - 1} step={1}
            value={pos} aria-label={T.effortTitle}
            onChange={(e) => { const n = Number(e.target.value); setPos(n); onChange(EFFORT_LEVELS[n]); }} />
          <div className="effortNow">{T.effortLevel(EFFORT_LEVELS[pos])}</div>
        </div>
      )}
    </div>
  );
}
