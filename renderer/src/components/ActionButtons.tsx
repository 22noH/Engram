import { useState } from 'react';
import type { Action } from '../../../shared/protocol';

// 메시지에 실린 actions를 버튼 줄로. 되돌릴 수 없는 것(confirm 있음)만 네이티브 confirm 한 번.
// 한 번 보내면 전체 비활성화(중복 전송 방지). label은 React 이스케이프로만(XSS), send는 ws로만 나감.
export function ActionButtons({ actions, onSend }: { actions: Action[]; onSend: (text: string) => void }) {
  const [done, setDone] = useState(false);
  const click = (a: Action) => {
    if (done) return;
    if (a.confirm && !window.confirm(a.confirm)) return; // 거부 시 미전송(비활성화도 안 함)
    setDone(true);
    onSend(a.send);
  };
  return (
    <div className="actions">
      {actions.map((a) => (
        <button key={a.label} disabled={done} onClick={() => click(a)}>{a.label}</button>
      ))}
    </div>
  );
}
