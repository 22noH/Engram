// 3영역 + Wiki 네비 탭. Team은 flag on일 때만(있으면 최전방). Wiki는 항상. Admin은 owner에게만(맨 뒤).
// R2-1(Quiet Library 라운드2) — 표시 순서만 Team 우선으로 변경(Team·Chat·Code·Wiki·Admin). 기본 선택
// 모드는 App.tsx의 useState('chat')가 독립적으로 관리하므로 이 순서 변경의 영향을 받지 않는다.
export function areaTabs(teamChat: boolean, admin = false): ('chat' | 'code' | 'team' | 'wiki' | 'admin')[] {
  const base: ('chat' | 'code' | 'team' | 'wiki' | 'admin')[] = teamChat ? ['team', 'chat', 'code', 'wiki'] : ['chat', 'code', 'wiki'];
  return admin ? [...base, 'admin'] : base;
}
