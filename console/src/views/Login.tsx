import { useState, type FormEvent } from 'react';
import { T } from '../i18n';
import { apiLogin, saveSession, type Session } from '../api';

// 목업 갭: 로그인 화면은 원본 목업에 없다(①셋업만 있음) — 브리프 지시대로 .setup 카드의
// 시각 문법을 그대로 재사용해 구현. 컨트롤러가 이 화면을 목업에 추가해 승인해야 한다(report 참조).
export function Login({ serverName, onDone }: { serverName: string; onDone: (s: Session) => void }) {
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await apiLogin(loginId, password);
    setBusy(false);
    if ('error' in r) {
      setError(
        r.error === 'pending' ? T.errPending
        : r.error === 'suspended' ? T.errSuspended
        : r.error === 'invalid' ? T.errInvalid
        : T.errNetwork,
      );
      return;
    }
    saveSession(r);
    onDone(r);
  };

  return (
    <div className="page">
      <form className="setup" onSubmit={submit}>
        <div className="wordmark">{T.wordmark}</div>
        <h2>{T.signInTitle(serverName)}</h2>
        <label htmlFor="loginId">{T.loginIdLabel}</label>
        <input id="loginId" placeholder={T.loginIdLabel}
               value={loginId} onChange={(e) => setLoginId(e.target.value)} />
        <label htmlFor="loginPassword">{T.passwordLabel}</label>
        <input id="loginPassword" type="password" placeholder={T.passwordLabel}
               value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <div className="err">{error}</div>}
        <button type="submit" disabled={busy}>{T.loginSubmit}</button>
      </form>
    </div>
  );
}
