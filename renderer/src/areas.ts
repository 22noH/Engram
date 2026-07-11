// 3영역 + Wiki 네비 탭. Team은 flag on일 때만. Wiki는 항상. Admin은 owner에게만(맨 뒤).
export function areaTabs(teamChat: boolean, admin = false): ('chat' | 'code' | 'team' | 'wiki' | 'admin')[] {
  const base: ('chat' | 'code' | 'team' | 'wiki' | 'admin')[] = teamChat ? ['chat', 'team', 'code', 'wiki'] : ['chat', 'code', 'wiki'];
  return admin ? [...base, 'admin'] : base;
}
