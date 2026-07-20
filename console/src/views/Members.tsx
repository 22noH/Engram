import { Fragment, useEffect, useState } from 'react';
import { T } from '../i18n';
import {
  fetchMembers, fetchGroups, createMember, setMemberStatus, setMemberPermissions,
  resetMemberPassword, deleteMember,
  type MemberDto, type GroupDto,
} from '../api';
import { Nav, type NavKey } from '../components/Nav';
import { PERMISSIONS, permissionLabel } from '../permissions';

// ③ 멤버 — 목업 픽셀 그대로(+ 버튼→인라인 폼, 가입 대기 그룹, 멤버 그룹, 권한 편집은 목업에
// 상태가 안 그려져 있어 그룹 화면의 체크박스 문법을 재사용해 인라인으로 폈다 — report 참조).
// S2 풍성판(task-3c): 거절=삭제(확인 후 DELETE, 승인 대기는 되돌릴 상태가 없어 정지가 아니라
// 계정 자체를 지운다 — 백엔드 계약과 동일한 결)/비번 리셋=서버가 새 임시 비번을 만들어 돌려주면
// 그 값을 owner에게만 인라인으로 잠깐 보여준다(재조회 불가 — 창을 닫으면 다시 못 봄, 목업엔 없는
// 신규 UI라 report에 명시).

function genTempPassword(): string {
  return 'init-' + Math.random().toString(36).slice(2, 6);
}

export function Members({ serverName, role, active, onNavigate }: {
  serverName: string; role: string; active: NavKey; onNavigate: (k: NavKey) => void;
}) {
  const [members, setMembers] = useState<MemberDto[] | null>(null);
  const [groups, setGroups] = useState<GroupDto[] | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [loginId, setLoginId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [tempPassword, setTempPassword] = useState('');
  const [groupId, setGroupId] = useState('');
  const [busy, setBusy] = useState(false);
  const [permEditId, setPermEditId] = useState<string | null>(null);
  const [permDraft, setPermDraft] = useState<string[]>([]);
  const [resetBusyId, setResetBusyId] = useState<string | null>(null);
  const [resetInfo, setResetInfo] = useState<{ id: string; value: string } | null>(null);

  const load = () => {
    fetchMembers().then(setMembers);
    fetchGroups().then(setGroups);
  };
  useEffect(load, []);

  const openForm = () => {
    setLoginId(''); setDisplayName(''); setTempPassword(genTempPassword()); setGroupId('');
    setFormOpen(true);
  };

  const submitAdd = async () => {
    setBusy(true);
    const r = await createMember(loginId, displayName, tempPassword, groupId || undefined);
    setBusy(false);
    if (!('error' in r)) { setFormOpen(false); load(); }
  };

  const changeStatus = async (id: string, status: 'active' | 'suspended') => {
    await setMemberStatus(id, status);
    load();
  };

  const rejectMember = async (m: MemberDto) => {
    if (!window.confirm(T.rejectMemberConfirm(m.displayName))) return;
    await deleteMember(m.id);
    load();
  };

  const doResetPassword = async (id: string) => {
    setResetBusyId(id);
    const r = await resetMemberPassword(id);
    setResetBusyId(null);
    if (!('error' in r)) setResetInfo({ id, value: r.tempPassword });
  };

  const openPerms = (m: MemberDto) => { setPermEditId(m.id); setPermDraft(m.permissions); };
  const togglePerm = (p: string) => {
    setPermDraft((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
  };
  const savePerms = async (id: string) => {
    await setMemberPermissions(id, permDraft);
    setPermEditId(null);
    load();
  };

  const pending = members?.filter((m) => m.status === 'pending') ?? [];
  const main = members?.filter((m) => m.status !== 'pending') ?? [];

  return (
    <div className="page">
      <div className="frame">
        <Nav serverName={serverName} address={window.location.host} active={active} onNavigate={onNavigate}
             pendingMembers={pending.length} role={role} />
        <div className="main">
          <div className="head-row">
            <div className="t">
              <h2>{T.membersTitle}</h2>
              <div className="sub">{T.membersSub}</div>
            </div>
            <button className="btn-accent" onClick={openForm}>{T.addMemberBtn}</button>
          </div>

          {formOpen && (
            <>
              <div className="grp-h">{T.addMemberHeading}</div>
              <div className="grp form">
                <div className="frow">
                  <label>{T.loginIdLabel}</label>
                  <input value={loginId} onChange={(e) => setLoginId(e.target.value)} placeholder={T.loginIdLabel} />
                </div>
                <div className="frow">
                  <label>{T.displayNameLabel}</label>
                  <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={T.displayNamePlaceholder} />
                </div>
                <div className="frow">
                  <label>{T.tempPasswordLabel}</label>
                  <input value={tempPassword} onChange={(e) => setTempPassword(e.target.value)} style={{ fontFamily: 'var(--mono)' }} />
                  <span className="hint">{T.tempPasswordHint}</span>
                </div>
                <div className="frow">
                  <label>{T.groupLabel}</label>
                  <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                    {(groups ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    <option value="">{T.noGroupOption}</option>
                  </select>
                </div>
                <div className="frow end">
                  <button className="btn-accent compact" disabled={busy} onClick={submitAdd}>{T.createBtn}</button>
                </div>
              </div>
            </>
          )}

          {pending.length > 0 && (
            <>
              <div className="grp-h">{T.pendingHeading(pending.length)}</div>
              <div className="grp">
                {pending.map((m) => (
                  <div className="row" key={m.id}>
                    <div className="who"><div className="n">{m.displayName}</div><div className="id">{m.loginId}</div></div>
                    <span className="chip pend">{T.pendingChip}</span>
                    <div className="btns">
                      <button className="pri" onClick={() => changeStatus(m.id, 'active')}>{T.approveBtn}</button>
                      <button onClick={() => rejectMember(m)}>{T.rejectBtn}</button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="grp-h">{T.membersHeading(main.length)}</div>
          <div className="grp">
            {main.map((m) => (
              <Fragment key={m.id}>
                <div className="row">
                  <div className="who">
                    <div className="n">{m.role === 'owner' ? T.meServerOwner : m.displayName}</div>
                    <div className="id">{m.loginId}</div>
                  </div>
                  {m.role === 'owner' && <span className="chip owner">owner</span>}
                  {m.role !== 'owner' && m.groups.map((gn) => <span className="chip plain" key={gn}>{gn}</span>)}
                  {m.role !== 'owner' && m.status === 'active' && <span className="chip">{T.activeChip}</span>}
                  {m.role !== 'owner' && m.status === 'suspended' && <span className="chip susp">{T.suspendedChip}</span>}
                  <div className="btns">
                    {m.status !== 'suspended' && <button onClick={() => openPerms(m)}>{T.permissionsBtn}</button>}
                    {m.role !== 'owner' && m.status === 'active' && (
                      <>
                        <button disabled={resetBusyId === m.id} onClick={() => doResetPassword(m.id)}>{T.resetPasswordBtn}</button>
                        <button className="danger" onClick={() => changeStatus(m.id, 'suspended')}>{T.suspendBtn}</button>
                      </>
                    )}
                    {m.status === 'suspended' && <button onClick={() => changeStatus(m.id, 'active')}>{T.restoreBtn}</button>}
                  </div>
                </div>
                {permEditId === m.id && (
                  <div className="row">
                    <div className="frow">
                      <div className="perms">
                        {PERMISSIONS.map((p) => (
                          <label key={p}>
                            <input type="checkbox" checked={permDraft.includes(p)} onChange={() => togglePerm(p)} />
                            {permissionLabel(p)}
                          </label>
                        ))}
                      </div>
                    </div>
                    <div className="btns">
                      <button className="pri" onClick={() => savePerms(m.id)}>{T.save}</button>
                      <button onClick={() => setPermEditId(null)}>{T.cancel}</button>
                    </div>
                  </div>
                )}
                {resetInfo?.id === m.id && (
                  <div className="row">
                    <div className="who">
                      <div className="n">{T.tempPasswordRevealHeading}</div>
                      <div className="id">{resetInfo.value}</div>
                      <div className="d">{T.tempPasswordRevealHint}</div>
                    </div>
                    <div className="btns">
                      <button onClick={() => setResetInfo(null)}>{T.closeBtn}</button>
                    </div>
                  </div>
                )}
              </Fragment>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
