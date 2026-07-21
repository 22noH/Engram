import { useEffect, useState } from 'react';
import { T } from '../i18n';
import {
  fetchServerSettings, saveServerSettings, fetchMembers,
  type ServerSettingsData, type MemberDto, type Exposure, type CodingMode, type RetentionPolicy,
} from '../api';
import { Nav, type NavKey } from '../components/Nav';
import { DeployCard } from '../components/DeployCard';

// 대화 보존 select = 목업 ⑨ "대화 보존" 행의 확정 3개 프리셋(브리프 결정 사항 그대로) — 임의 값
// 입력 UI가 아니라 이 3가지 중 하나만 고를 수 있다. 저장된 값이 프리셋과 정확히 일치하지 않아도
// (예: days=45) mode만 보고 그 프리셋을 선택한다 — 이 select 자체가 "3개 중 하나"라는 계약이라
// 로드 시점에 값을 프리셋으로 정규화하는 것은 손실이 아니라 이 위젯의 정의 그 자체다(report 참조).
const RETENTION_PRESETS: Record<RetentionPolicy['mode'], RetentionPolicy> = {
  count: { mode: 'count', value: 1000 },
  days: { mode: 'days', value: 90 },
  unlimited: { mode: 'unlimited' },
};

// ⑨ 서버 설정 + 클라이언트 배포 — 목업 픽셀 그대로이되 두 가지는 불가피하게 늘렸다(report 참조):
//  · SSO 블록: 목업엔 발급자 URL 입력 하나뿐이지만 실제 OIDC 계약은 clientId·clientSecret도
//    받는다(auth.config.ts) — 두 입력을 같은 .frow 문법으로 한 줄 더 추가했다.
//  · 포트·공개범위 옆에 "Applies after restart" 힌트를 붙였다 — 부팅 시점 설정이라 저장만으로는
//    반영되지 않는다(Global Constraints: 헤드리스는 재시작 전까지 이전 바인드로 계속 뜬다).
// (S4 Task 3): 목업의 "대화 보존" select를 여기 추가했다 — Task 2가 GET/POST에 retention 필드를
// 얹으면서 API 계약 밖이던 부분이 풀렸다(RETENTION_PRESETS 참조).
//  · 코딩 허용은 체크박스(off/auto 2단)가 아니라 백엔드 실계약대로 3단 select다(off/auto/allowlist —
//    review 지적: 체크박스는 저장 때마다 codingMode를 무조건 실어 보내 allowlist를 auto로 몰래
//    강등시켰다). OIDC 블록과 같은 결로 codingTouched 플래그를 둬서, 사용자가 이 select를 실제로
//    건드리지 않은 저장(예: 서버 이름만 바꿔 저장)은 codingMode 필드 자체를 아예 안 보낸다.
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
  const [codingMode, setCodingMode] = useState<CodingMode>('off');
  const [codingTouched, setCodingTouched] = useState(false);
  const [retentionMode, setRetentionMode] = useState<RetentionPolicy['mode']>('unlimited');
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
        setCodingMode(d.codingMode);
        setCodingTouched(false);
        setRetentionMode(d.retention?.mode ?? 'unlimited');
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
      ...(codingTouched ? { codingMode } : {}),
      ...(oidcTouched ? { oidc: { issuer: oidcIssuer, clientId: oidcClientId, clientSecret: oidcClientSecret } } : {}),
      retention: RETENTION_PRESETS[retentionMode],
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
              <select value={codingMode} style={{ maxWidth: 220 }}
                      onChange={(e) => { setCodingMode(e.target.value as CodingMode); setCodingTouched(true); }}>
                <option value="off">{T.codingOff}</option>
                <option value="auto">{T.codingAuto}</option>
                <option value="allowlist">{T.codingAllowlist}</option>
              </select>
              <span className="hint">{T.codingHint}</span>
            </div>
            <div className="frow">
              <label>{T.retentionLabel}</label>
              <select value={retentionMode} style={{ maxWidth: 220 }}
                      onChange={(e) => setRetentionMode(e.target.value as RetentionPolicy['mode'])}>
                <option value="count">{T.retentionCountOption}</option>
                <option value="days">{T.retentionDaysOption}</option>
                <option value="unlimited">{T.retentionUnlimitedOption}</option>
              </select>
              <span className="hint">{T.retentionHint}</span>
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
