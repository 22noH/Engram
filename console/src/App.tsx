import { useEffect, useState } from 'react';
import { fetchStatus, loadSession, UNAUTHORIZED_EVENT, type Session } from './api';
import { Setup } from './views/Setup';
import { Login } from './views/Login';
import { Overview } from './views/Overview';
import { Members } from './views/Members';
import { Groups } from './views/Groups';
import { Channels } from './views/Channels';
import { Models } from './views/Models';
import { Mcp } from './views/Mcp';
import { Wiki } from './views/Wiki';
import { ServerSettings } from './views/ServerSettings';
import { Deploy } from './views/Deploy';
import type { NavKey } from './components/Nav';

type View = 'loading' | 'setup' | 'login' | 'console';

// 라우팅: status.configured=false → Setup, configured+무세션 → Login, 세션 있음 → 콘솔(Nav로 화면 전환).
// 401은 api.ts가 UNAUTHORIZED_EVENT로 알려온다(어느 화면에서든 Login으로 복귀).
// S2(Task 3)부터 콘솔 내부 라우팅(nav 활성 키)을 여기서 들어올려 화면 4개(개요·멤버·그룹·채널)를
// 전환한다 — 각 view는 S1의 Overview 관성대로 자기 frame+Nav를 스스로 그린다(자체완결 컴포넌트).
export default function App() {
  const [view, setView] = useState<View>('loading');
  const [serverName, setServerName] = useState('Engram Server');
  const [session, setSession] = useState<Session | null>(null);
  const [nav, setNav] = useState<NavKey>('overview');

  useEffect(() => {
    let cancelled = false;
    fetchStatus().then((status) => {
      if (cancelled) return;
      if (status?.serverName) setServerName(status.serverName);
      if (!status || status.configured === false) { setView('setup'); return; }
      const s = loadSession();
      if (s) { setSession(s); setView('console'); }
      else setView('login');
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onUnauthorized = () => { setSession(null); setView('login'); };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const onAuthed = (s: Session) => { setSession(s); setNav('overview'); setView('console'); };

  if (view === 'loading') return null;
  if (view === 'setup') return <Setup onDone={onAuthed} />;
  if (view === 'login') return <Login onDone={onAuthed} />;

  const consoleProps = { serverName, role: session?.user.role ?? 'member', active: nav, onNavigate: setNav };
  if (nav === 'members') return <Members {...consoleProps} />;
  if (nav === 'groups') return <Groups {...consoleProps} />;
  if (nav === 'channels') return <Channels {...consoleProps} />;
  if (nav === 'models') return <Models {...consoleProps} />;
  if (nav === 'mcp') return <Mcp {...consoleProps} />;
  if (nav === 'wiki') return <Wiki {...consoleProps} />;
  if (nav === 'settings') return <ServerSettings {...consoleProps} />;
  if (nav === 'deploy') return <Deploy {...consoleProps} />;
  return <Overview {...consoleProps} />;
}
