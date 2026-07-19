import { T } from '../i18n';

export type NavKey =
  | 'overview' | 'members' | 'groups' | 'channels' | 'models'
  | 'mcp' | 'wiki' | 'settings' | 'deploy' | 'status';

interface NavItem { key: NavKey; label: string; icon: string; color: string; enabled: boolean }

// 목업 10항목 그대로 — S1은 개요만 구현되어 나머지 8개는 비활성(dim+커서 기본+"곧 제공" 툴팁).
function items(): NavItem[] {
  return [
    { key: 'overview', label: T.navOverview, icon: '●', color: '#56d364', enabled: true },
    { key: 'members', label: T.navMembers, icon: '👥', color: '#3aa5de', enabled: false },
    { key: 'groups', label: T.navGroups, icon: '▣', color: '#1d9e75', enabled: false },
    { key: 'channels', label: T.navChannels, icon: '#', color: '#7f77dd', enabled: false },
    { key: 'models', label: T.navModels, icon: '▦', color: '#3aa5de', enabled: false },
    { key: 'mcp', label: T.navMcp, icon: '⌘', color: '#7f77dd', enabled: false },
    { key: 'wiki', label: T.navWiki, icon: '☁', color: '#1d9e75', enabled: false },
    { key: 'settings', label: T.navSettings, icon: '⚙', color: '#888780', enabled: false },
    { key: 'deploy', label: T.navDeploy, icon: '⬇', color: '#ba7517', enabled: false },
    { key: 'status', label: T.navStatus, icon: '≡', color: '#56d364', enabled: false },
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
