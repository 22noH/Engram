import { useEffect, useState } from 'react';
import { T } from '../i18n';
import { fetchChannels, setChannelVisibility, deleteChannel, type ChannelDto } from '../api';
import { Nav, type NavKey } from '../components/Nav';

// ⑤ 채널 — 목업 픽셀 구조를 따르되, 실제 visibility는 public/private 2값뿐이라(Task 2 계약)
// 목업의 3단계 접근범위(공개/그룹 한정/비공개)와 행별 버튼(모델/접근/멤버)은 브리프 Interfaces
// 절 문구("visibility 전환·삭제")대로 토글+삭제 2버튼으로 단순화했다 — report 참조.
export function Channels({ serverName, role, active, onNavigate }: {
  serverName: string; role: string; active: NavKey; onNavigate: (k: NavKey) => void;
}) {
  const [channels, setChannels] = useState<ChannelDto[] | null>(null);

  const load = () => { fetchChannels().then(setChannels); };
  useEffect(load, []);

  const toggle = async (c: ChannelDto) => {
    await setChannelVisibility(c.id, c.visibility === 'public' ? 'private' : 'public');
    load();
  };
  const remove = async (id: string) => {
    await deleteChannel(id);
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
            {(channels ?? []).map((c) => (
              <div className="row" key={c.id}>
                <div className="who">
                  <div className="n"># {c.name}</div>
                  <div className="id">
                    {c.visibility === 'public' ? T.allMembers : T.channelMemberCount(c.memberCount)}
                    {' · '}{T.modelLabel}: {c.brain ?? T.defaultModel}
                  </div>
                </div>
                <span className={`chip${c.visibility === 'private' ? ' susp' : ' plain'}`}>
                  {c.visibility === 'public' ? T.publicChip : T.privateChip}
                </span>
                <div className="btns">
                  <button onClick={() => toggle(c)}>{c.visibility === 'public' ? T.makePrivateBtn : T.makePublicBtn}</button>
                  <button className="danger" onClick={() => remove(c.id)}>{T.deleteBtn}</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
