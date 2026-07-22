import { useState } from 'react';
import type { Connection } from '../connections';
import { T } from '../i18n';

// Engram 추가/삭제/기본 지정 모달. 저장은 App이 onAdd/onRemove/onSetDefault로 받은 상태를
// setConnState에 반영 → useEffect가 saveConnections(localStorage)로 영속화한다(이 컴포넌트는 순수 UI).
// XSS: 이름·endpoint는 React 텍스트 노드로만 렌더(innerHTML 없음).
//
// 3영역 재설계(모달 참사 교훈 — "로컬 모델 추가" 버튼이 실은 신규 로컬 Engram 인스턴스를
// 만드는 것이었는데 AI 모델 설정처럼 보여 무피드백 5연타로 5개 생성됨):
//   1) Connected — 기존 연결 목록(동작 무변경)
//   2) Connect a remote Engram — 기존 이름/엔드포인트 입력(동작 무변경)
//   3) Advanced — create a separate local Engram — 기본 접힘, 별도 이름 입력(원격 폼과 미공유),
//      2클릭 확인(무장→확인) + 진행 중 버튼 비활성화로 연타 방지.
export function ManageEngrams(props: {
  connections: Connection[];
  defaultConnId: string;
  onAdd: (name: string, endpoint: string) => void;
  onRemove: (id: string) => void;
  onSetDefault: (id: string) => void;
  onClose: () => void;
}) {
  const { connections, defaultConnId, onAdd, onRemove, onSetDefault, onClose } = props;
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [localName, setLocalName] = useState('');
  const [armed, setArmed] = useState(false);
  const [creating, setCreating] = useState(false);

  const submit = () => {
    if (!name.trim() || !endpoint.trim()) return;
    onAdd(name.trim(), endpoint.trim());
    setName(''); setEndpoint('');
  };

  const createLocal = () => {
    if (creating) return;
    if (!armed) { setArmed(true); return; }
    setCreating(true);
    void window.engramDesktop!.addLocalBrain!(localName.trim() || 'Local brain').then((r) => {
      if (r) { onAdd(r.name, r.endpoint); setLocalName(''); }
    }).finally(() => { setCreating(false); setArmed(false); });
  };

  return (
    <div id="manageOverlay" onClick={onClose}>
      <div id="manageModal" onClick={(e) => {
        e.stopPropagation();
        // 확인 무장 해제: 확인 버튼 자체가 아닌 다른 어디를 클릭해도 2클릭 확인이 풀린다
        // (버튼 클릭 자체는 이 핸들러보다 먼저 버블링돼 createLocal이 실행된 뒤 여기 도달).
        if (armed && !(e.target as HTMLElement).closest('.localCreateRow button')) setArmed(false);
      }}>
        <h2>{T.manageEngrams}</h2>
        <div className="sectionLabel">{T.connectedLabel}</div>
        <div id="engramList">
          <div className="engramListHead">{T.engrams}</div>
          {connections.map((c) => (
            <div key={c.id} className="engramRow">
              <span className="name">{c.name}</span>
              <span className="endpoint">{c.endpoint}</span>
              {c.id === defaultConnId ? (
                <span className="default">{T.default}</span>
              ) : (
                <button type="button" onClick={() => onSetDefault(c.id)}>{T.setDefault}</button>
              )}
              <button type="button" className="danger" disabled={connections.length <= 1}
                onClick={() => onRemove(c.id)}>{T.removeEngram}</button>
            </div>
          ))}
        </div>
        <div className="sectionLabel">{T.connectRemoteLabel}</div>
        <div id="addEngram">
          <input type="text" placeholder={T.engramNamePh} value={name} onChange={(e) => setName(e.target.value)} />
          <input type="text" placeholder={T.engramEndpointPh} value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
          <button type="button" onClick={submit}>{T.addEngram}</button>
        </div>
        {window.engramDesktop?.addLocalBrain && (
          <details id="advancedLocal" onToggle={(e) => { if (!(e.target as HTMLDetailsElement).open) setArmed(false); }}>
            <summary>{T.advancedLocalLabel}</summary>
            <p className="hint">{T.localEngramHint}</p>
            <div className="localCreateRow">
              <input type="text" placeholder={T.workspaceNamePh} value={localName}
                onChange={(e) => { setLocalName(e.target.value); setArmed(false); }} />
              <button type="button" disabled={creating} onClick={createLocal}>
                {armed ? T.confirmCreateLocal : T.addLocalBrain}
              </button>
            </div>
          </details>
        )}
        <button type="button" id="manageClose" onClick={onClose}>{T.close}</button>
      </div>
    </div>
  );
}
