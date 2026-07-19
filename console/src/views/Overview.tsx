import { useEffect, useState } from 'react';
import { T } from '../i18n';
import { fetchOverview, type Overview as OverviewData } from '../api';
import { Nav, type NavKey } from '../components/Nav';

// ② 개요 — 목업 픽셀 그대로. 타일 4개(멤버·채널·위키 페이지·오늘 대화) + 처리할 일.
// T2 개요 계약(overview.ts)이 pendingMemberNames/pendingProposalTitles(이름·제안 제목, 최초 5개
// 미리보기)까지 포함하도록 확장돼 "처리할 일" 행에 이름/제목을 상세줄로 함께 그린다.
export function Overview({ serverName, role }: { serverName: string; role: string }) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [active, setActive] = useState<NavKey>('overview');

  useEffect(() => {
    let cancelled = false;
    fetchOverview().then((d) => { if (!cancelled) setData(d); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="page">
      <div className="frame">
        <Nav
          serverName={serverName}
          address={window.location.host}
          active={active}
          onNavigate={setActive}
          pendingMembers={data?.pendingMembers}
          role={role}
        />
        <div className="main">
          <h2>{T.overviewTitle}</h2>
          <div className="sub">{T.overviewSub}</div>
          {data ? (
            <>
              <div className="statgrid">
                <div className="grp stat"><div className="l">{T.statMembers}</div><div className="v">{data.members}</div></div>
                <div className="grp stat"><div className="l">{T.statChannels}</div><div className="v">{data.channels}</div></div>
                <div className="grp stat"><div className="l">{T.statWikiPages}</div><div className="v">{data.wikiPages}</div></div>
                <div className="grp stat"><div className="l">{T.statTodayMessages}</div><div className="v">{data.todayMessages}</div></div>
              </div>
              {(data.pendingMembers > 0 || data.pendingProposals > 0) && (
                <>
                  <div className="grp-h">{T.todoHeading}</div>
                  <div className="grp">
                    {data.pendingMembers > 0 && (
                      <div className="row">
                        <div className="who">
                          <div className="n">{T.pendingMembersRow(data.pendingMembers)}</div>
                          {data.pendingMemberNames.length > 0 && <div className="d">{data.pendingMemberNames.join(', ')}</div>}
                        </div>
                        <div className="btns">
                          <button className="pri" disabled title={T.comingSoon}>{T.goToMembers}</button>
                        </div>
                      </div>
                    )}
                    {data.pendingProposals > 0 && (
                      <div className="row">
                        <div className="who">
                          <div className="n">{T.pendingProposalsRow(data.pendingProposals)}</div>
                          {data.pendingProposalTitles.length > 0 && <div className="d">{data.pendingProposalTitles.join(', ')}</div>}
                        </div>
                        <div className="btns">
                          <button className="pri" disabled title={T.comingSoon}>{T.goToWiki}</button>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="sub">{T.loading}</div>
          )}
        </div>
      </div>
    </div>
  );
}
