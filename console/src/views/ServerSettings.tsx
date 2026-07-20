import { useEffect, useState } from 'react';
import { T } from '../i18n';
import {
  fetchServerSettings, saveServerSettings, fetchMembers,
  type ServerSettingsData, type MemberDto, type Exposure,
} from '../api';
import { Nav, type NavKey } from '../components/Nav';
import { DeployCard } from '../components/DeployCard';

// ⑨ 서버 설정 + 클라이언트 배포 — 목업 픽셀 그대로이되 두 가지는 불가피하게 늘렸다(report 참조):
//  · SSO 블록: 목업엔 발급자 URL 입력 하나뿐이지만 실제 OIDC 계약은 clientId·clientSecret도
//    받는다(auth.config.ts) — 두 입력을 같은 .frow 문법으로 한 줄 더 추가했다.
//  · 포트·공개범위 옆에 "Applies after restart" 힌트를 붙였다 — 부팅 시점 설정이라 저장만으로는
//    반영되지 않는다(Global Constraints: 헤드리스는 재시작 전까지 이전 바인드로 계속 뜬다).
// 그리고 하나는 뺐다: 목업의 "대화 보존" select는 이 API 계약 밖(백엔드에 필드·엔드포인트가 없음
// — 플랜 self-review에 상태·로그와 함께 S4로 명시돼 있다).
export function ServerSettings({ serverName, role, active, onNavigate }: {
  serverName: string; role: string; active: NavKey; onNavigate: (k: NavKey) => void;
}) {
  const [data, setData] = useState<ServerSettingsData | null>(null);
  const [members, setMembers] = useState<MemberDto[] | null>(null);
  const [name, setName] = useState('');
  const [port, setPort] = useState('');
  const [exposure, setExposure] = useState<Exposure>('local');
  const [oidcIssuer, setOidcIssuer] = useState('');
  const [oidcClientId, setOidcClientId] = useState('');
  const [oidcClientSecret, setOidcClientSecret] = useState('');
  const [codingOn, setCodingOn] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => {
    fetchServerSettings().then((d) => {
      setData(d);
      if (d) {
        setName(d.serverName ?? '');
        setPort(String(d.port));
        setExposure(d.exposure);
        setOidcIssuer(d.oidcIssuer ?? '');
        setOidcClientId(d.oidcClientId ?? '');
        setOidcClientSecret('');
        setCodingOn(d.codingMode !== 'off');
      }
    });
    fetchMembers().then(setMembers);
  };
  useEffect(load, []);

  const submit = async () => {
    setBusy(true);
    const oidcTouched = oidcIssuer.trim() || oidcClientId.trim() || oidcClientSecret.trim();
    const ok = await saveServerSettings({
      serverName: name,
      port,
      exposure,
      codingMode: codingOn ? 'auto' : 'off',
      ...(oidcTouched ? { oidc: { issuer: oidcIssuer, clientId: oidcClientId, clientSecret: oidcClientSecret } } : {}),
    });
    setBusy(false);
    setOidcClientSecret(''); // 원문은 성공·실패 무관 입력칸에 남기지 않는다(보안 요구).
    if (ok) load();
  };

  const pendingMembers = (members ?? []).filter((m) => m.status === 'pending').length;

  return (
    <div className="page">
      <div className="frame">
        <Nav serverName={serverName} address={window.location.host} active={active} onNavigate={onNavigate}
             pendingMembers={pendingMembers} role={role} />
        <div className="main">
          <h2>{T.serverSettingsTitle}</h2>
          <div className="sub">{T.serverSettingsSub}</div>

          <div className="grp form">
            <div className="frow">
              <label>{T.serverNameLabel}</label>
              <input value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 'none', flex: 1 }} />
            </div>
            <div className="frow">
              <label>{T.portLabel}</label>
              <input value={port} onChange={(e) => setPort(e.target.value)} style={{ maxWidth: 120 }} />
              <span className="hint">{T.portHint} · {T.restartHint}</span>
            </div>
            <div className="frow">
              <label>{T.exposureLabel}</label>
              <select value={exposure} onChange={(e) => setExposure(e.target.value as Exposure)} style={{ maxWidth: 220 }}>
                <option value="local">{T.exposureLocal}</option>
                <option value="lan">{T.exposureLan}</option>
                <option value="internet">{T.exposureInternet}</option>
              </select>
              <span className="hint">{T.exposureHint} · {T.restartHint}</span>
            </div>
            <div className="frow">
              <label>{T.ssoLabel}</label>
              <input value={oidcIssuer} onChange={(e) => setOidcIssuer(e.target.value)}
                     placeholder={T.oidcIssuerPlaceholder} style={{ maxWidth: 'none', flex: 1 }} />
            </div>
            <div className="frow">
              <label></label>
              <input value={oidcClientId} onChange={(e) => setOidcClientId(e.target.value)}
                     placeholder={T.oidcClientIdPlaceholder} style={{ maxWidth: 260 }} />
              <input type="password" value={oidcClientSecret} onChange={(e) => setOidcClientSecret(e.target.value)}
                     placeholder={T.oidcClientSecretPlaceholder} style={{ maxWidth: 260 }} />
              {data?.hasOidcSecret && <span className="hint">{T.setLabel}</span>}
            </div>
            <div className="frow">
              <label>{T.codingLabel}</label>
              <label style={{ width: 'auto', color: 'var(--text)', fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: 7 }}>
                <input type="checkbox" checked={codingOn} onChange={(e) => setCodingOn(e.target.checked)}
                       style={{ accentColor: 'var(--accent)' }} />
                {T.codingOffDefault}
              </label>
              <span className="hint">{T.codingHint}</span>
            </div>
          </div>
          <div className="savebar"><button disabled={busy} onClick={submit}>{T.save}</button></div>

          <div className="grp-h">{T.clientDeployHeading}</div>
          <DeployCard />
        </div>
      </div>
    </div>
  );
}
