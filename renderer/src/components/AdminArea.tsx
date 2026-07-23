import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AdminUserDto, AdminSettings } from '../../../shared/protocol';
import { T } from '../i18n';

// 권한 체크박스 목록(스펙 §3.4) — active·비owner 행에서 부여/회수한다.
const PERM_KEYS: { key: string; label: string }[] = [
  { key: 'wiki.approve', label: T.permWikiApprove },
  { key: 'channels.manage', label: T.permChannelsManage },
  { key: 'wiki.unpublish', label: T.permWikiUnpublish },
  { key: 'wiki.edit', label: T.permWikiEdit },
  { key: 'wiki.delete', label: T.permWikiDelete },
];

// R2-2 — 이니셜 아바타(순수 프레젠테이션). Array.from으로 서로게이트 페어까지 세이프하게 다뤄
// 단어 2개면 각 첫 글자, 단어 1개면 CJK(한글 자모~한자 대역)는 1자(음절 자체가 이미 조합형),
// 그 외(라틴 등)는 앞 2자.
function initials(name: string): string {
  const trimmed = (name || '').trim();
  if (!trimmed) return '?';
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const a = Array.from(words[0])[0] ?? '';
    const b = Array.from(words[1])[0] ?? '';
    return (a + b).toUpperCase();
  }
  const chars = Array.from(words[0]);
  const cp = chars[0]?.codePointAt(0) ?? 0;
  const isCJK = cp >= 0x1100 && cp <= 0x9fff;
  return (isCJK ? chars.slice(0, 1) : chars.slice(0, 2)).join('').toUpperCase();
}

// 관리 영역(스펙 §2.5) — owner에게만 App이 렌더. 순수 UI, 통신은 App 콜백(ws admin 프레임).
// R2-2 — 목업 ② 픽셀 재설계(눈썹+제목/승인 대기 하이라이트 카드/멤버 카드 리스트+권한 칩/눈썹 설정 섹션).
// props 인터페이스는 T1 그대로 — 프레젠테이션 재구성만, ws 프레임·App 배선 무변경(기능 패리티 하드룰).
export function AdminArea(props: {
  users: AdminUserDto[]; settings: AdminSettings | null;
  onApprove: (id: string) => void; onSuspend: (id: string) => void; onRestore: (id: string) => void;
  onResetPassword: (id: string, password: string) => void; onForceLogout: (id: string) => void;
  onSaveSettings: (s: AdminSettings) => void; onSetPermissions: (id: string, permissions: string[]) => void;
}) {
  const [serverName, setServerName] = useState('');
  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  useEffect(() => {
    setServerName(props.settings?.serverName ?? '');
    setIssuer(props.settings?.oidc?.issuer ?? '');
    setClientId(props.settings?.oidc?.clientId ?? '');
    setClientSecret(props.settings?.oidc?.clientSecret ?? '');
  }, [props.settings]);

  const statusLabel: Record<AdminUserDto['status'], string> = {
    pending: T.statusPending, active: T.statusActive, suspended: T.statusSuspended,
  };

  // 행 ⋯ 액션 메뉴 + 권한 토글 팝오버 — Channels.tsx의 #popmenu 패턴 재사용(앵커 rect 실측 후 배치,
  // 바깥클릭/Esc로 닫힘). 동시에 하나만 열리므로 kind로 내용만 분기.
  const [menu, setMenu] = useState<{ id: string; kind: 'actions' | 'perms'; ax: number; ay: number } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => { if (!popRef.current?.contains(e.target as Node)) setMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menu]);

  const openMenu = (id: string, kind: 'actions' | 'perms', anchor: HTMLElement) => {
    const r = anchor.getBoundingClientRect();
    setMenu({ id, kind, ax: r.left, ay: r.bottom });
    setPos({ left: -9999, top: -9999 });
  };

  useLayoutEffect(() => {
    if (!menu || !popRef.current) return;
    const w = popRef.current.offsetWidth, h = popRef.current.offsetHeight;
    setPos({
      left: Math.max(8, Math.min(menu.ax, window.innerWidth - w - 8)),
      top: Math.min(menu.ay + 4, window.innerHeight - h - 8),
    });
  }, [menu]);

  // 승인 대기는 상단 하이라이트 카드로 분리, 나머지(active/suspended)는 카드 리스트.
  const pending = props.users.filter((u) => u.status === 'pending');
  const roster = props.users.filter((u) => u.status !== 'pending');
  const menuUser = menu ? props.users.find((u) => u.id === menu.id) : undefined;

  return (
    <div id="adminArea">
      <div className="eyebrow">{T.adminWorkspaceEyebrow(props.users.length)}</div>
      <h3>{T.adminMembers}</h3>

      {pending.length > 0 && (
        <div id="adminPending">
          {pending.map((u) => (
            <div key={u.id} className="pendingCard">
              <div className="avatar">{initials(u.displayName)}</div>
              <div className="info">
                <div className="name">{u.displayName}</div>
                <div className="sub">{T.adminWaitingApproval}</div>
              </div>
              {/* 원본 UI엔 status 무관 resetPw(!sso)가 있었다 — pending도 예외 없음(기능 패리티).
                  sso 계정은 애초에 해당 없어 ⋯를 아예 숨긴다. */}
              {!u.sso && (
                <button type="button" className="moreBtn" title={T.adminMoreActions}
                  onClick={(e) => openMenu(u.id, 'actions', e.currentTarget)}>⋯</button>
              )}
              <button type="button" onClick={() => props.onApprove(u.id)}>{T.adminApprove}</button>
              <button type="button" className="rejectBtn" onClick={() => props.onSuspend(u.id)}>{T.adminReject}</button>
            </div>
          ))}
        </div>
      )}

      <div id="adminUsers">
        {roster.map((u) => (
          <div key={u.id} className="memberRow">
            <div className="avatar">{initials(u.displayName)}</div>
            <div className="nameCol">
              <span className="name">{u.displayName}</span>
              <span className="login">{u.loginId}{u.sso ? ' (SSO)' : ''}</span>
            </div>
            <span className={'pill ' + (u.role === 'owner' ? 'owner' : u.status)}>
              {u.role === 'owner' ? T.roleOwner : statusLabel[u.status]}
            </span>
            {u.role === 'owner' ? (
              <span className="perms" title={T.adminPermissions}>{T.permAll}</span>
            ) : u.status === 'active' ? (
              <span className="chips" title={T.adminPermissions}>
                {PERM_KEYS.filter(({ key }) => u.permissions.includes(key)).map(({ key, label }) => (
                  <span key={key} className="chip">{label}</span>
                ))}
                <button type="button" className="chip addChip" title={T.adminAddPermission}
                  onClick={(e) => openMenu(u.id, 'perms', e.currentTarget)}>+</button>
              </span>
            ) : <span className="chips" />}
            <button type="button" className="rowMenuBtn" title={T.adminMoreActions}
              onClick={(e) => openMenu(u.id, 'actions', e.currentTarget)}>⋯</button>
          </div>
        ))}
      </div>

      {menu && menuUser && (
        <div id="popmenu" ref={popRef} style={{ left: pos.left, top: pos.top }}>
          {menu.kind === 'perms' ? (
            <>
              <div className="popLabel">{T.adminPermissions}</div>
              {PERM_KEYS.map(({ key, label }) => (
                <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer' }}>
                  <input type="checkbox" data-perm={key}
                    checked={menuUser.permissions.includes(key)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...menuUser.permissions, key]
                        : menuUser.permissions.filter((p) => p !== key);
                      props.onSetPermissions(menuUser.id, next);
                    }} />
                  {label}
                </label>
              ))}
            </>
          ) : (
            <>
              {menuUser.status === 'suspended' && (
                <div onClick={() => { setMenu(null); props.onRestore(menuUser.id); }}>{T.adminRestore}</div>
              )}
              {menuUser.status === 'active' && menuUser.role !== 'owner' && (
                <div className="danger" onClick={() => { setMenu(null); props.onSuspend(menuUser.id); }}>{T.adminSuspend}</div>
              )}
              {!menuUser.sso && (
                <div onClick={() => { setMenu(null); const p = window.prompt(T.adminNewPwPrompt); if (p) props.onResetPassword(menuUser.id, p); }}>
                  {T.adminResetPw}
                </div>
              )}
              {menuUser.status === 'active' && (
                <div onClick={() => { setMenu(null); props.onForceLogout(menuUser.id); }}>{T.adminForceLogout}</div>
              )}
            </>
          )}
        </div>
      )}

      <div className="eyebrow">{T.adminSettings}</div>
      <div id="adminSettings">
        <input type="text" placeholder={T.adminServerNamePh} value={serverName} onChange={(e) => setServerName(e.target.value)} />
        <button type="button" onClick={() => setIssuer('https://accounts.google.com')}>{T.adminPresetGoogle}</button>
        <input type="text" placeholder={T.adminOidcIssuerPh} value={issuer} onChange={(e) => setIssuer(e.target.value)} />
        <input type="text" placeholder={T.adminOidcClientIdPh} value={clientId} onChange={(e) => setClientId(e.target.value)} />
        <input type="password" placeholder={T.adminOidcSecretPh} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
        <button type="button" onClick={() => props.onSaveSettings({
          ...(serverName.trim() ? { serverName: serverName.trim() } : {}),
          ...(issuer.trim() && clientId.trim() ? { oidc: { issuer: issuer.trim(), clientId: clientId.trim(), clientSecret: clientSecret.trim() } } : {}),
        })}>{T.adminSave}</button>
      </div>
    </div>
  );
}
