import { useState } from 'react';
import type { AuthStatus } from '../auth-api';
import { T } from '../i18n';

// 앱 로그인 게이트(Phase 16a). 배포 형태 분리(2026-07-19 설계 §2.2)로 "내 서버 만들기" 셋업 폼은
// 삭제 — 미설정 원격 서버는 안내 1줄로 대체(원격 owner 셋업은 서버 CLI 소관). 설정됨=로그인/가입.
// 순수 UI — 실제 호출(fetch)은 App이 콜백으로 담당한다. XSS: 전부 React 텍스트 노드(innerHTML 없음).
export function LoginGate(props: {
  connName: string;
  status: AuthStatus;
  onLogin: (loginId: string, password: string) => void;
  onRegister: (loginId: string, password: string, displayName: string) => void;
  onSso: () => void;
  error?: string;
  notice?: string;
}) {
  const { status } = props;
  const [view, setView] = useState<'login' | 'register'>('login');
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');

  const errText = props.error === 'invalid' ? T.errInvalid
    : props.error === 'pending' ? T.errPending
    : props.error === 'suspended' ? T.errSuspended
    : props.error ? T.errNetwork : '';

  const fields = (
    <>
      <input type="text" placeholder={T.loginIdPh} value={loginId} onChange={(e) => setLoginId(e.target.value)} />
      <input type="password" placeholder={T.passwordPh} value={password} onChange={(e) => setPassword(e.target.value)} />
    </>
  );

  // 서버 이름을 제목 안에서 별도 노드로 감싼다(스크린리더/테스트가 이름만 짚을 수 있게).
  const serverName = status.serverName ?? props.connName;
  const titleFull = T.signInTitle(serverName);
  const nameIdx = titleFull.indexOf(serverName);
  const titlePrefix = nameIdx >= 0 ? titleFull.slice(0, nameIdx) : '';
  const titleSuffix = nameIdx >= 0 ? titleFull.slice(nameIdx + serverName.length) : titleFull;

  return (
    <div id="loginGate">
      <div id="loginCard">
        {!status.configured ? (
          <p className="notice">{T.serverNotSetup}</p>
        ) : view === 'login' ? (
          <>
            <h2>{titlePrefix}<b>{serverName}</b>{titleSuffix}</h2>
            {fields}
            <button type="button" onClick={() => props.onLogin(loginId, password)}>{T.signIn}</button>
            {status.oidc && <button type="button" className="sso" onClick={props.onSso}>{T.ssoBtn}</button>}
            <a onClick={() => setView('register')}>{T.registerLink}</a>
          </>
        ) : (
          <>
            <h2>{T.registerLink}</h2>
            {fields}
            <input type="text" placeholder={T.displayNameFieldPh} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            <button type="button" onClick={() => props.onRegister(loginId, password, displayName)}>{T.registerBtn}</button>
            <a onClick={() => setView('login')}>{T.backToLogin}</a>
          </>
        )}
        {errText && <div className="err">{errText}</div>}
        {props.notice && <div className="notice">{props.notice}</div>}
      </div>
    </div>
  );
}
