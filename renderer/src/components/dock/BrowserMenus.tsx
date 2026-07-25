import { useState } from 'react';
import { T } from '../../i18n';
import {
  addServer, type ConfirmMode, type DevServer, type DockPrefs, forgetSite, loadAllowedSites,
  nextConfirmMode, removeServer,
} from '../../dock/prefs';

// 자동 확인 3단계 라벨(목업 승인분) — 한 줄을 누르면 다음 단계로 돈다.
const CONFIRM_LABEL: Record<ConfirmMode, string> = {
  ask: T.dockAgentConfirmAsk,
  local: T.dockAgentConfirmLocal,
  auto: T.dockAgentConfirmAuto,
};

// 브라우저 칸의 두 드롭다운(목업 dock-menus-mockup.html 승인분).
//  ① 서버 — 개발 서버 목록/실행 표시/시작·중지/서버 추가
//  ② 더보기(⋮) — 파일 열기 · 스크린샷 저장 · 허용된 사이트 관리 · 채팅 링크 토글 · 세션 유지
// 실행 자체는 기존 pty-manager 재사용(DockPanel이 터미널 탭을 하나 만들어 명령을 친다) — 여기선
// "무엇을 눌렀는지"만 위로 알린다.

export function ServerMenu({ channelId, servers, runningIds, onChanged, onToggle, onClose }: {
  channelId: string;
  servers: DevServer[];
  runningIds: string[];
  onChanged: () => void;
  onToggle: (srv: DevServer, running: boolean) => void;
  onClose: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [port, setPort] = useState('');
  const [command, setCommand] = useState('');

  const submit = () => {
    if (!addServer(channelId, { name, port, command })) return; // 이름·명령이 비면 무시
    setName(''); setPort(''); setCommand(''); setAdding(false);
    onChanged();
  };

  return (
    <div className="dockMenu" onMouseDown={(e) => e.stopPropagation()}>
      <div className="dockMenuHead">{T.dockServers}</div>
      {servers.length === 0 && !adding && <div className="dockMenuEmpty">{T.dockServerNone}</div>}
      {servers.map((s) => {
        const running = runningIds.includes(s.id);
        return (
          <div key={s.id} className="dockMenuItem">
            <span className={'dockDot' + (running ? ' on' : '')} />
            <span className="dockMenuLabel">{s.name}</span>
            <span className="dockMenuVal">{s.port ? ':' + s.port : ''}</span>
            <button type="button" className="dockMenuPlay" title={running ? T.dockServerStop : T.dockServerStart}
              onClick={() => { onToggle(s, running); onClose(); }}>{running ? '■' : '▶'}</button>
            <button type="button" className="dockMenuX" title={T.dockServerRemove}
              onClick={() => { removeServer(channelId, s.id); onChanged(); }}>✕</button>
          </div>
        );
      })}
      <div className="dockMenuSep" />
      {adding ? (
        <div className="dockMenuForm">
          <input value={name} placeholder={T.dockServerName} onChange={(e) => setName(e.target.value)} />
          <input value={port} placeholder={T.dockServerPort} inputMode="numeric" onChange={(e) => setPort(e.target.value)} />
          <input value={command} placeholder={T.dockServerCommand} onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          <button type="button" onClick={submit}>{T.dockAdd}</button>
        </div>
      ) : (
        <div className="dockMenuItem clickable" onClick={() => setAdding(true)}>
          <span className="dockMenuIcon">＋</span><span className="dockMenuLabel">{T.dockServerAdd}</span>
        </div>
      )}
    </div>
  );
}

export function MoreMenu({ prefs, onPrefs, onOpenFile, onScreenshot, onClose }: {
  prefs: DockPrefs;
  onPrefs: (next: DockPrefs) => void;
  onOpenFile: () => void;
  onScreenshot: () => void;
  onClose: () => void;
}) {
  const [sites, setSites] = useState<string[] | null>(null);

  return (
    <div className="dockMenu wide" onMouseDown={(e) => e.stopPropagation()}>
      {/* AI 웹 조작(2단계) — 1단계에서 일부러 비워뒀던 자리. 조작 없이 넣으면 빈 껍데기였다. */}
      <div className="dockMenuHead">{T.dockAgentSection}</div>
      <div className="dockMenuItem clickable" onClick={() => onPrefs({ ...prefs, agentEnabled: !prefs.agentEnabled })}>
        <span className="dockMenuIcon">🤖</span>
        <span className="dockMenuLabel">{T.dockAgentEnabled}</span>
        <span className="dockMenuCheck">{prefs.agentEnabled ? '✓' : ''}</span>
      </div>
      <div className="dockMenuItem clickable" title={T.dockAgentConfirmHint}
        onClick={() => onPrefs({ ...prefs, confirmMode: nextConfirmMode(prefs.confirmMode) })}>
        <span className="dockMenuIcon" />
        <span className="dockMenuLabel">{T.dockAgentConfirm}</span>
        <span className="dockMenuVal">{CONFIRM_LABEL[prefs.confirmMode]} ›</span>
      </div>
      <div className="dockMenuSep" />
      <div className="dockMenuItem clickable" onClick={() => { onOpenFile(); onClose(); }}>
        <span className="dockMenuIcon">📂</span><span className="dockMenuLabel">{T.dockOpenFile}</span>
      </div>
      <div className="dockMenuItem clickable" onClick={() => { onScreenshot(); onClose(); }}>
        <span className="dockMenuIcon">📷</span><span className="dockMenuLabel">{T.dockScreenshot}</span>
      </div>
      <div className="dockMenuItem clickable" onClick={() => setSites(sites ? null : loadAllowedSites())}>
        <span className="dockMenuIcon">🛡</span><span className="dockMenuLabel">{T.dockAllowedSites}</span>
        <span className="dockMenuVal">{sites ? '▾' : '›'}</span>
      </div>
      {sites && (
        <div className="dockSiteList">
          {sites.length === 0 && <div className="dockMenuEmpty">{T.dockAllowedNone}</div>}
          {sites.map((h) => (
            <div key={h} className="dockSiteRow">
              <span className="dockMenuLabel">{h}</span>
              <button type="button" className="dockMenuX"
                onClick={() => { forgetSite(h); setSites(loadAllowedSites()); }}>✕</button>
            </div>
          ))}
        </div>
      )}
      <div className="dockMenuSep" />
      <div className="dockMenuItem clickable" onClick={() => onPrefs({ ...prefs, openLinksHere: !prefs.openLinksHere })}>
        <span className="dockMenuIcon" />
        <span className="dockMenuLabel">{T.dockOpenLinksHere}</span>
        <span className="dockMenuCheck">{prefs.openLinksHere ? '✓' : ''}</span>
      </div>
      <div className="dockMenuItem clickable" title={T.dockKeepSessionHint}
        onClick={() => onPrefs({ ...prefs, keepSession: !prefs.keepSession })}>
        <span className="dockMenuIcon" />
        <span className="dockMenuLabel">{T.dockKeepSession}</span>
        <span className="dockMenuVal">{prefs.keepSession ? T.dockKeepSessionOn : T.dockKeepSessionOff}</span>
      </div>
    </div>
  );
}
