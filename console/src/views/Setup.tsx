import { useState, type FormEvent } from 'react';
import { T } from '../i18n';
import { apiSetup, saveSession, type Session } from '../api';

// ① 첫 접속 — 셋업 마법사(목업 픽셀 그대로). 코드는 데모 값이 아니라 빈 입력으로 시작.
export function Setup({ onDone }: { onDone: (s: Session) => void }) {
  const [code, setCode] = useState('');
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await apiSetup(code, loginId, password);
    setBusy(false);
    if ('error' in r) { setError(T.errSetup); return; }
    saveSession(r);
    onDone(r);
  };

  return (
    <div className="page">
      <form className="setup" onSubmit={submit}>
        <div className="wordmark">{T.wordmark}</div>
        <h2>{T.setupTitle}</h2>
        <div className="sub">{T.setupSub}</div>
        <label htmlFor="setupCode">{T.codeLabel}</label>
        <input id="setupCode" className="code" placeholder="xxxx-xxxx-xxxx"
               value={code} onChange={(e) => setCode(e.target.value)} />
        <label htmlFor="setupLoginId">{T.loginIdLabel}</label>
        <input id="setupLoginId" placeholder={T.loginIdLabel}
               value={loginId} onChange={(e) => setLoginId(e.target.value)} />
        <label htmlFor="setupPassword">{T.passwordLabel}</label>
        <input id="setupPassword" type="password" placeholder={T.passwordLabel}
               value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <div className="err">{error}</div>}
        <button type="submit" disabled={busy}>{T.setupSubmit}</button>
        <div className="steps"><i className="on" /><i /></div>
      </form>
    </div>
  );
}
