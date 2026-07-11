import { useEffect, useState } from 'react';
import type { AdminUserDto, AdminSettings } from '../../../shared/protocol';
import { T } from '../i18n';

// 관리 영역(스펙 §2.5) — owner에게만 App이 렌더. 순수 UI, 통신은 App 콜백(ws admin 프레임).
export function AdminArea(props: {
  users: AdminUserDto[]; settings: AdminSettings | null;
  onApprove: (id: string) => void; onSuspend: (id: string) => void; onRestore: (id: string) => void;
  onResetPassword: (id: string, password: string) => void; onForceLogout: (id: string) => void;
  onSaveSettings: (s: AdminSettings) => void;
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

  return (
    <div id="adminArea">
      <h3>{T.adminMembers}</h3>
      <div id="adminUsers">
        {props.users.map((u) => (
          <div key={u.id} className="adminRow">
            <span className="name">{u.displayName}</span>
            <span className="login">{u.loginId}{u.sso ? ' (SSO)' : ''}</span>
            <span className={'status ' + u.status}>{statusLabel[u.status]}{u.role === 'owner' ? ' · owner' : ''}</span>
            {u.status === 'pending' && <button onClick={() => props.onApprove(u.id)}>{T.adminApprove}</button>}
            {u.status === 'pending' && <button className="danger" onClick={() => props.onSuspend(u.id)}>{T.adminSuspend}</button>}
            {u.status === 'active' && u.role !== 'owner' && <button className="danger" onClick={() => props.onSuspend(u.id)}>{T.adminSuspend}</button>}
            {u.status === 'suspended' && <button onClick={() => props.onRestore(u.id)}>{T.adminRestore}</button>}
            {!u.sso && <button onClick={() => { const p = window.prompt(T.adminNewPwPrompt); if (p) props.onResetPassword(u.id, p); }}>{T.adminResetPw}</button>}
            {u.status === 'active' && <button onClick={() => props.onForceLogout(u.id)}>{T.adminForceLogout}</button>}
          </div>
        ))}
      </div>
      <h3>{T.adminSettings}</h3>
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
