import { useEffect, useState } from 'react';
import { fetchStatus, loadSession, UNAUTHORIZED_EVENT, type Session } from './api';
import { Setup } from './views/Setup';
import { Login } from './views/Login';
import { Overview } from './views/Overview';

type View = 'loading' | 'setup' | 'login' | 'overview';

// 라우팅: status.configured=false → Setup, configured+무세션 → Login, 세션 있음 → Overview.
// 401은 api.ts가 UNAUTHORIZED_EVENT로 알려온다(어느 화면에서든 Login으로 복귀).
export default function App() {
  const [view, setView] = useState<View>('loading');
  const [serverName, setServerName] = useState('Engram Server');
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchStatus().then((status) => {
      if (cancelled) return;
      if (status?.serverName) setServerName(status.serverName);
      if (!status || status.configured === false) { setView('setup'); return; }
      const s = loadSession();
      if (s) { setSession(s); setView('overview'); }
      else setView('login');
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onUnauthorized = () => { setSession(null); setView('login'); };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const onAuthed = (s: Session) => { setSession(s); setView('overview'); };

  if (view === 'loading') return null;
  if (view === 'setup') return <Setup onDone={onAuthed} />;
  if (view === 'login') return <Login onDone={onAuthed} />;
  return <Overview serverName={serverName} role={session?.user.role ?? 'member'} />;
}
