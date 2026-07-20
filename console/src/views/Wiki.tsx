import { useEffect, useState } from 'react';
import { T } from '../i18n';
import { fetchWiki, saveWikiRemote, fetchMembers, type WikiData, type MemberDto } from '../api';
import { Nav, type NavKey } from '../components/Nav';

// ⑧ 위키 — 목업 픽셀 그대로이되 통계 타일은 2개(페이지·승인 대기)뿐이다: GET /admin/api/wiki에
// lastSync 필드가 없어(admin-http.ts — overview()와 같은 소스만 재사용) 목업의 "마지막 동기화"
// 3번째 타일은 뺐다(report 참조 — 이 화면의 API 계약 범위 자체가 그렇게 정의됨).
export function Wiki({ serverName, role, active, onNavigate }: {
  serverName: string; role: string; active: NavKey; onNavigate: (k: NavKey) => void;
}) {
  const [data, setData] = useState<WikiData | null>(null);
  const [members, setMembers] = useState<MemberDto[] | null>(null);
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    fetchWiki().then((d) => {
      setData(d);
      if (d) { setUrl(d.remote.url ?? ''); setBranch(d.remote.branch ?? 'main'); }
    });
    fetchMembers().then(setMembers);
  };
  useEffect(load, []);

  const submitRemote = async () => {
    setBusy(true);
    await saveWikiRemote(url, branch);
    setBusy(false);
    load();
  };

  const pendingMembers = (members ?? []).filter((m) => m.status === 'pending').length;

  return (
    <div className="page">
      <div className="frame">
        <Nav serverName={serverName} address={window.location.host} active={active} onNavigate={onNavigate}
             pendingMembers={pendingMembers} role={role} />
        <div className="main">
          <h2>{T.wikiOpsTitle}</h2>
          <div className="sub">{T.wikiOpsSub}</div>

          <div className="statgrid" style={{ gridTemplateColumns: 'repeat(2,1fr)' }}>
            <div className="grp stat"><div className="l">{T.statPages}</div><div className="v">{data?.pages ?? 0}</div></div>
            <div className="grp stat">
              <div className="l">{T.statPendingProposals}</div>
              <div className="v" style={data && data.pendingProposals > 0 ? { color: 'var(--warn)' } : undefined}>
                {data?.pendingProposals ?? 0}
              </div>
            </div>
          </div>

          <div className="grp-h">{T.gitRemoteHeading}</div>
          <div className="grp form">
            <div className="frow">
              <label>{T.remoteRepoLabel}</label>
              <input value={url} onChange={(e) => setUrl(e.target.value)} style={{ maxWidth: 'none', flex: 1 }} />
            </div>
            <div className="frow">
              <label>{T.branchLabel}</label>
              <input value={branch} onChange={(e) => setBranch(e.target.value)} style={{ maxWidth: 140 }} />
              <span className="hint">{T.syncHint}</span>
            </div>
            <div className="frow end">
              <button className="btn-accent compact" disabled={busy} onClick={submitRemote}>{T.save}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
