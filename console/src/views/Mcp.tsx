import { useEffect, useState } from 'react';
import { T } from '../i18n';
import { fetchMcp, addMcp, deleteMcp, fetchMembers, type McpServerDto, type MemberDto } from '../api';
import { Nav, type NavKey } from '../components/Nav';

// ⑦ MCP — 목업 픽셀 그대로. source==='claude'(클로드 미러 소유) 항목은 ⊖ 버튼 대신
// "Claude 관리" 칩을 보여준다(admin-http.ts DELETE가 403으로 거부하는 것과 맞춰 UI에서부터 숨김).
export function Mcp({ serverName, role, active, onNavigate }: {
  serverName: string; role: string; active: NavKey; onNavigate: (k: NavKey) => void;
}) {
  const [servers, setServers] = useState<McpServerDto[] | null>(null);
  const [members, setMembers] = useState<MemberDto[] | null>(null);
  const [name, setName] = useState('');
  const [commandOrUrl, setCommandOrUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    fetchMcp().then(setServers);
    fetchMembers().then(setMembers);
  };
  useEffect(load, []);

  const submitAdd = async () => {
    if (!name.trim() || !commandOrUrl.trim()) return;
    setBusy(true);
    const ok = await addMcp(name, commandOrUrl);
    setBusy(false);
    if (ok) { setName(''); setCommandOrUrl(''); load(); }
  };

  const remove = async (n: string) => {
    await deleteMcp(n);
    load();
  };

  const pendingMembers = (members ?? []).filter((m) => m.status === 'pending').length;

  return (
    <div className="page">
      <div className="frame">
        <Nav serverName={serverName} address={window.location.host} active={active} onNavigate={onNavigate}
             pendingMembers={pendingMembers} role={role} />
        <div className="main">
          <h2>{T.mcpTitle}</h2>
          <div className="sub">{T.mcpSub}</div>

          <div className="grp-h">{T.registeredServersHeading}</div>
          <div className="grp">
            {(servers ?? []).map((s) => (
              <div className="row" key={s.name}>
                <div className="who">
                  <div className="n">{s.name}</div>
                  <div className="id">{s.url ?? [s.command, ...(s.args ?? [])].filter(Boolean).join(' ')}</div>
                </div>
                <div className="btns">
                  {s.source === 'claude'
                    ? <span className="chip plain">{T.claudeManagedChip}</span>
                    : <button className="danger" onClick={() => remove(s.name)}>⊖</button>}
                </div>
              </div>
            ))}
          </div>

          <div className="grp-h">{T.addHeading}</div>
          <div className="grp form">
            <div className="frow">
              <label>{T.mcpNameLabel}</label>
              <input value={name} onChange={(e) => setName(e.target.value)}
                     placeholder={T.mcpNameLabel} style={{ maxWidth: 160 }} />
              <label style={{ width: 'auto' }}>{T.mcpCommandOrUrlLabel}</label>
              <input value={commandOrUrl} onChange={(e) => setCommandOrUrl(e.target.value)}
                     placeholder={T.mcpCommandOrUrlPlaceholder} style={{ maxWidth: 'none', flex: 1 }} />
              <button className="btn-accent compact" disabled={busy} onClick={submitAdd}>{T.addBtn}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
