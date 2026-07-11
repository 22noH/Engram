import { useState } from 'react';
import type { Connection } from '../connections';
import { T } from '../i18n';

// Engram 추가/삭제/기본 지정 모달. 저장은 App이 onAdd/onRemove/onSetDefault로 받은 상태를
// setConnState에 반영 → useEffect가 saveConnections(localStorage)로 영속화한다(이 컴포넌트는 순수 UI).
// XSS: 이름·endpoint는 React 텍스트 노드로만 렌더(innerHTML 없음).
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

  const submit = () => {
    if (!name.trim() || !endpoint.trim()) return;
    onAdd(name.trim(), endpoint.trim());
    setName(''); setEndpoint('');
  };

  return (
    <div id="manageOverlay" onClick={onClose}>
      <div id="manageModal" onClick={(e) => e.stopPropagation()}>
        <h2>{T.manageEngrams}</h2>
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
        <div id="addEngram">
          <input type="text" placeholder={T.engramNamePh} value={name} onChange={(e) => setName(e.target.value)} />
          <input type="text" placeholder={T.engramEndpointPh} value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
          <button type="button" onClick={submit}>{T.addEngram}</button>
          {window.engramDesktop?.addLocalBrain && (
            <button type="button" onClick={() => {
              void window.engramDesktop!.addLocalBrain!(name.trim() || 'Local brain').then((r) => {
                if (r) { onAdd(r.name, r.endpoint); setName(''); }
              });
            }}>{T.addLocalBrain}</button>
          )}
        </div>
        <button type="button" id="manageClose" onClick={onClose}>{T.close}</button>
      </div>
    </div>
  );
}
