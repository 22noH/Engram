import { useEffect, useState } from 'react';
import { T } from '../i18n';
import { fetchMembers, type MemberDto } from '../api';
import { Nav, type NavKey } from '../components/Nav';
import { DeployCard } from '../components/DeployCard';

// 목업 나머지 스크린엔 "클라이언트 배포"가 ⑨서버설정 화면 하단 카드로만 그려져 있지만, 목업 네비에는
// 별도 항목으로도 나열돼 있다(모든 화면 나비게이션에 "클라이언트 배포"가 독립 항목으로 존재 — 그
// 항목이 "on" 상태인 스크린 자체는 목업에 없음). 브리프 지시대로 그 네비 항목이 눌렸을 때를 위한
// 최소 전용 뷰 — 목업에 없는 픽셀을 새로 만들지 않고 ⑨의 배포 카드(DeployCard)를 그대로 재사용한다.
export function Deploy({ serverName, role, active, onNavigate }: {
  serverName: string; role: string; active: NavKey; onNavigate: (k: NavKey) => void;
}) {
  const [members, setMembers] = useState<MemberDto[] | null>(null);
  useEffect(() => { fetchMembers().then(setMembers); }, []);
  const pendingMembers = (members ?? []).filter((m) => m.status === 'pending').length;

  return (
    <div className="page">
      <div className="frame">
        <Nav serverName={serverName} address={window.location.host} active={active} onNavigate={onNavigate}
             pendingMembers={pendingMembers} role={role} />
        <div className="main">
          <h2>{T.clientDeployHeading}</h2>
          <DeployCard />
        </div>
      </div>
    </div>
  );
}
