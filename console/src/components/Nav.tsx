import { T } from '../i18n';

export type NavKey =
  | 'overview' | 'members' | 'groups' | 'channels' | 'models'
  | 'mcp' | 'wiki' | 'settings' | 'deploy' | 'status';

interface NavItem { key: NavKey; label: string; icon: string; color: string; enabled: boolean }

// 목업 10항목 그대로 — S4부터 상태·로그까지 구현되어 전 네비 항목 활성.
// 실측 픽스(Task 5): 원래 항목마다 다른 채도 높은 원색(초록/파랑/보라/주황 등)이었는데, Quiet
// Library는 전 표면에 걸쳐 액센트 하나(--accent)만 쓰는 절제된 팔레트라 이 무지개 타일들이 실기기에서
// 눈에 띄게 겉돌았다(Task 4가 미리 지적한 항목). 아이콘 자체로 항목은 이미 구분되므로 장식용 배경색은
// 토큰 하나로 통일 — .tile의 텍스트색도 함께 var(--accent-text)로 바꿔야 다크(밝은 세이지 --accent)에서
// 대비가 산다(기존 하드코딩 #fff는 다크 액센트가 밝아 대비가 약했다).
function items(): NavItem[] {
  return [
    { key: 'overview', label: T.navOverview, icon: '●', color: 'var(--accent)', enabled: true },
    { key: 'members', label: T.navMembers, icon: '👥', color: 'var(--accent)', enabled: true },
    { key: 'groups', label: T.navGroups, icon: '▣', color: 'var(--accent)', enabled: true },
    { key: 'channels', label: T.navChannels, icon: '#', color: 'var(--accent)', enabled: true },
    { key: 'models', label: T.navModels, icon: '▦', color: 'var(--accent)', enabled: true },
    { key: 'mcp', label: T.navMcp, icon: '⌘', color: 'var(--accent)', enabled: true },
    { key: 'wiki', label: T.navWiki, icon: '☁', color: 'var(--accent)', enabled: true },
    { key: 'settings', label: T.navSettings, icon: '⚙', color: 'var(--accent)', enabled: true },
    { key: 'deploy', label: T.navDeploy, icon: '⬇', color: 'var(--accent)', enabled: true },
    { key: 'status', label: T.navStatus, icon: '≡', color: 'var(--accent)', enabled: true },
  ];
}

export function Nav({ serverName, address, active, onNavigate, pendingMembers, role }: {
  serverName: string;
  address: string;
  active: NavKey;
  onNavigate: (k: NavKey) => void;
  pendingMembers?: number;
  role: string;
}) {
  return (
    <div className="nav">
      <div className="head">
        <div className="srv">{serverName}</div>
        <div className="addr">{address}</div>
      </div>
      {items().map((it) => (
        <div
          key={it.key}
          className={`nitem${it.key === active ? ' on' : ''}${it.enabled ? '' : ' disabled'}`}
          title={it.enabled ? undefined : T.comingSoon}
          onClick={it.enabled ? () => onNavigate(it.key) : undefined}
        >
          <span className="tile" style={{ background: it.color }}>{it.icon}</span>
          {it.label}
          {it.key === 'members' && !!pendingMembers && <span className="nbadge">{pendingMembers}</span>}
        </div>
      ))}
      <div className="foot"><span className="dotok" />{T.statusOk} · {T.loggedInAs(role)}</div>
    </div>
  );
}
