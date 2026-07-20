import { useEffect, useState } from 'react';
import { T } from '../i18n';
import {
  fetchChannels, fetchGroups, fetchMembers, fetchChannelDetail,
  setChannelVisibility, setChannelMembers, setChannelGroups, deleteChannel,
  type ChannelDto, type GroupDto, type MemberDto,
} from '../api';
import { Nav, type NavKey } from '../components/Nav';

// ⑤ 채널 — 목업 픽셀 그대로: 3단계 접근범위 배지(공개/그룹 한정/비공개)는 visibility+groups[]에서
// 파생(브리프 계약: public→공개, private && groups.length>0→그룹 한정, private && groups.length===0→비공개).
// 행별 버튼도 목업 그대로(모델은 항상 비활성 — S3에서 배정 화면이 붙는다). "멤버"/"접근" 편집기는
// 목업에 그 안이 그려져 있지 않은 신규 UI(체크박스 다중선택, 멤버 권한 편집과 같은 문법) — report 참조.
// 유일한 의도적 이탈: 비공개(그룹 0)인 행은 목업 예시엔 "멤버" 버튼만 있지만, 접근 모델이 개인∪그룹
// 합집합이라 owner가 그룹으로도 채널을 채울 수 있어야 해서 "접근" 버튼도 같이 노출한다(브리프 지시).
export function Channels({ serverName, role, active, onNavigate }: {
  serverName: string; role: string; active: NavKey; onNavigate: (k: NavKey) => void;
}) {
  const [channels, setChannels] = useState<ChannelDto[] | null>(null);
  const [groups, setGroups] = useState<GroupDto[] | null>(null);
  const [members, setMembers] = useState<MemberDto[] | null>(null);

  const [editor, setEditor] = useState<{ channelId: string; kind: 'members' | 'groups' } | null>(null);
  const [editorMemberIds, setEditorMemberIds] = useState<string[]>([]);
  const [editorGroupIds, setEditorGroupIds] = useState<string[]>([]);
  const [editorLoading, setEditorLoading] = useState(false);

  const load = () => {
    fetchChannels().then(setChannels);
    fetchGroups().then(setGroups);
    fetchMembers().then(setMembers);
  };
  useEffect(load, []);

  const tierOf = (c: ChannelDto): 'public' | 'groupLimited' | 'private' => {
    if (c.visibility === 'public') return 'public';
    return c.groups.length > 0 ? 'groupLimited' : 'private';
  };

  const makePrivate = async (c: ChannelDto) => {
    await setChannelVisibility(c.id, 'private');
    load();
  };

  const remove = async (c: ChannelDto) => {
    if (!window.confirm(T.deleteChannelConfirm(c.name))) return;
    await deleteChannel(c.id);
    load();
  };

  const openMembersEditor = async (c: ChannelDto) => {
    setEditor({ channelId: c.id, kind: 'members' });
    setEditorLoading(true);
    const detail = await fetchChannelDetail(c.id);
    setEditorMemberIds(detail?.memberIds ?? []);
    setEditorLoading(false);
  };
  const openGroupsEditor = async (c: ChannelDto) => {
    setEditor({ channelId: c.id, kind: 'groups' });
    setEditorLoading(true);
    const detail = await fetchChannelDetail(c.id);
    setEditorGroupIds(detail?.groupIds ?? []);
    setEditorLoading(false);
  };

  const toggleEditorMember = (id: string) => {
    setEditorMemberIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  };
  const toggleEditorGroup = (id: string) => {
    setEditorGroupIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  };

  const saveMembersEditor = async () => {
    if (!editor) return;
    await setChannelMembers(editor.channelId, editorMemberIds);
    setEditor(null);
    load();
  };
  const saveGroupsEditor = async () => {
    if (!editor) return;
    await setChannelGroups(editor.channelId, editorGroupIds);
    setEditor(null);
    load();
  };

  return (
    <div className="page">
      <div className="frame">
        <Nav serverName={serverName} address={window.location.host} active={active} onNavigate={onNavigate} role={role} />
        <div className="main">
          <h2>{T.channelsTitle}</h2>
          <div className="sub">{T.channelsSub}</div>
          <div className="grp">
            {(channels ?? []).map((c) => {
              const tier = tierOf(c);
              return (
                <div key={c.id}>
                  <div className="row">
                    <div className="who">
                      <div className="n"># {c.name}</div>
                      <div className="id">
                        {tier === 'public' && T.allMembers}
                        {tier === 'groupLimited' && c.groups.join(', ')}
                        {tier === 'private' && T.channelMemberCount(c.memberCount)}
                        {' · '}{T.modelLabel}: {c.brain ?? T.defaultModel}
                      </div>
                    </div>
                    <span className={`chip${tier === 'private' ? ' susp' : tier === 'groupLimited' ? ' plain' : ''}`}>
                      {tier === 'public' && T.publicChip}
                      {tier === 'groupLimited' && T.groupLimitedChip}
                      {tier === 'private' && T.privateChip}
                    </span>
                    <div className="btns">
                      <button disabled title={T.modelBtnTooltip}>{T.modelBtn}</button>
                      {tier === 'public' && <button onClick={() => makePrivate(c)}>{T.makePrivateBtn}</button>}
                      {tier === 'groupLimited' && <button onClick={() => openGroupsEditor(c)}>{T.accessBtn}</button>}
                      {tier === 'private' && <button onClick={() => openMembersEditor(c)}>{T.channelMembersBtn}</button>}
                      {tier === 'private' && <button onClick={() => openGroupsEditor(c)}>{T.accessBtn}</button>}
                      <button className="danger" onClick={() => remove(c)}>{T.deleteBtn}</button>
                    </div>
                  </div>
                  {editor?.channelId === c.id && editor.kind === 'members' && (
                    <div className="row">
                      <div className="perms">
                        {(members ?? []).map((m) => (
                          <label key={m.id}>
                            <input type="checkbox" checked={editorMemberIds.includes(m.id)}
                                   onChange={() => toggleEditorMember(m.id)} />
                            {m.displayName}
                          </label>
                        ))}
                      </div>
                      <div className="btns">
                        <button className="pri" disabled={editorLoading} onClick={saveMembersEditor}>{T.save}</button>
                        <button onClick={() => setEditor(null)}>{T.cancel}</button>
                      </div>
                    </div>
                  )}
                  {editor?.channelId === c.id && editor.kind === 'groups' && (
                    <div className="row">
                      <div className="perms">
                        {(groups ?? []).map((g) => (
                          <label key={g.id}>
                            <input type="checkbox" checked={editorGroupIds.includes(g.id)}
                                   onChange={() => toggleEditorGroup(g.id)} />
                            {g.name}
                          </label>
                        ))}
                      </div>
                      <div className="btns">
                        <button className="pri" disabled={editorLoading} onClick={saveGroupsEditor}>{T.save}</button>
                        <button onClick={() => setEditor(null)}>{T.cancel}</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
