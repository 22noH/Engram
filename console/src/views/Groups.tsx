import { useEffect, useState } from 'react';
import { T } from '../i18n';
import {
  fetchGroups, fetchMembers, fetchChannels, createGroup, patchGroup, deleteGroup,
  type GroupDto, type MemberDto, type ChannelDto,
} from '../api';
import { Nav, type NavKey } from '../components/Nav';
import { PERMISSIONS, permissionLabel } from '../permissions';

// ④ 그룹 — 목업 픽셀 그대로(멤버 칩·권한 체크박스·채널 접근 칩). 목업엔 없는 "그룹 만들기" 폼
// 상태와 멤버/채널 추가 피커는 브리프 지시(추가는 피커/셀렉트로)를 따라 최소한으로 채웠다 — report 참조.
export function Groups({ serverName, role, active, onNavigate }: {
  serverName: string; role: string; active: NavKey; onNavigate: (k: NavKey) => void;
}) {
  const [groups, setGroups] = useState<GroupDto[] | null>(null);
  const [members, setMembers] = useState<MemberDto[] | null>(null);
  const [channels, setChannels] = useState<ChannelDto[] | null>(null);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [pickingMember, setPickingMember] = useState(false);
  const [pickingChannel, setPickingChannel] = useState(false);

  const load = () => {
    fetchGroups().then(setGroups);
    fetchMembers().then(setMembers);
    fetchChannels().then(setChannels);
  };
  useEffect(load, []);

  const startEdit = (g: GroupDto) => {
    setEditingId(g.id);
    setName(g.name);
    setMemberIds(g.memberIds);
    setPermissions(g.permissions);
    setChannelIds(g.channelIds);
    setPickingMember(false);
    setPickingChannel(false);
  };

  const submitCreate = async () => {
    if (!newName.trim()) return;
    await createGroup(newName);
    setNewName('');
    setCreating(false);
    load();
  };

  const saveEdit = async () => {
    if (!editingId) return;
    await patchGroup(editingId, { name, memberIds, permissions, channelIds });
    setEditingId(null);
    load();
  };

  const removeGroup = async (id: string) => {
    await deleteGroup(id);
    if (editingId === id) setEditingId(null);
    load();
  };

  const togglePerm = (p: string) => {
    setPermissions((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
  };

  const memberName = (id: string) => members?.find((m) => m.id === id)?.displayName;
  const channelName = (id: string) => channels?.find((c) => c.id === id)?.name;
  const addableMembers = (members ?? []).filter((m) => !memberIds.includes(m.id));
  const addableChannels = (channels ?? []).filter((c) => !channelIds.includes(c.id));

  return (
    <div className="page">
      <div className="frame">
        <Nav serverName={serverName} address={window.location.host} active={active} onNavigate={onNavigate} role={role} />
        <div className="main">
          <div className="head-row">
            <div className="t">
              <h2>{T.groupsTitle}</h2>
              <div className="sub">{T.groupsSub}</div>
            </div>
            <button className="btn-accent" onClick={() => setCreating(true)}>{T.addGroupBtn}</button>
          </div>

          {creating && (
            <div className="grp form">
              <div className="frow">
                <label>{T.groupNameLabel}</label>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={T.groupNameLabel} />
              </div>
              <div className="frow end">
                <button className="btn-accent compact" onClick={submitCreate}>{T.createBtn}</button>
              </div>
            </div>
          )}

          <div className="grp-h">{T.groupsHeading((groups ?? []).length)}</div>
          <div className="grp">
            {(groups ?? []).map((g) => (
              <div className={`row${g.id === editingId ? ' hl' : ''}`} key={g.id}>
                <div className="who">
                  <div className="n">{g.name}</div>
                  <div className="id">
                    {T.groupMemberCount(g.memberIds.length)}
                    {g.permissions.length > 0 && ` · ${g.permissions.map(permissionLabel).join(' · ')}`}
                  </div>
                </div>
                <div className="btns">
                  <button onClick={() => startEdit(g)}>{T.editBtn}</button>
                  <button className="danger" onClick={() => removeGroup(g.id)}>{T.deleteBtn}</button>
                </div>
              </div>
            ))}
          </div>

          {editingId && (
            <>
              <div className="grp-h">{T.editHeading(name)}</div>
              <div className="grp form">
                <div className="frow">
                  <label>{T.groupNameLabel}</label>
                  <input value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="frow">
                  <label>{T.membersLabel}</label>
                  <div className="chips">
                    {memberIds.map((id) => {
                      const n = memberName(id);
                      if (!n) return null; // 존재하지 않는 계정 id는 조용히 무시(Task 2 리뷰 지적)
                      return (
                        <button type="button" className="chip plain" key={id}
                                onClick={() => setMemberIds((cur) => cur.filter((x) => x !== id))}>{n} ✕</button>
                      );
                    })}
                    {pickingMember ? (
                      <select autoFocus value="" onChange={(e) => {
                        if (e.target.value) setMemberIds((cur) => [...cur, e.target.value]);
                        setPickingMember(false);
                      }}>
                        <option value="">{T.pickMemberPlaceholder}</option>
                        {addableMembers.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
                      </select>
                    ) : (
                      <button type="button" className="chip dashed" onClick={() => setPickingMember(true)}>{T.addChip}</button>
                    )}
                  </div>
                </div>
                <div className="frow">
                  <label>{T.permissionsLabel}</label>
                  <div className="perms">
                    {PERMISSIONS.map((p) => (
                      <label key={p}>
                        <input type="checkbox" checked={permissions.includes(p)} onChange={() => togglePerm(p)} />
                        {permissionLabel(p)}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="frow">
                  <label>{T.channelAccessLabel}</label>
                  <div className="chips">
                    {channelIds.map((id) => {
                      const n = channelName(id);
                      if (!n) return null; // 삭제된 채널 id는 조용히 무시(Task 2 리뷰 지적)
                      return (
                        <button type="button" className="chip plain" key={id}
                                onClick={() => setChannelIds((cur) => cur.filter((x) => x !== id))}># {n} ✕</button>
                      );
                    })}
                    {pickingChannel ? (
                      <select autoFocus value="" onChange={(e) => {
                        if (e.target.value) setChannelIds((cur) => [...cur, e.target.value]);
                        setPickingChannel(false);
                      }}>
                        <option value="">{T.pickChannelPlaceholder}</option>
                        {addableChannels.map((c) => <option key={c.id} value={c.id}># {c.name}</option>)}
                      </select>
                    ) : (
                      <button type="button" className="chip dashed" onClick={() => setPickingChannel(true)}>{T.addChannelChip}</button>
                    )}
                  </div>
                </div>
                <div className="frow end">
                  <button className="btn-accent compact" onClick={saveEdit}>{T.save}</button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
