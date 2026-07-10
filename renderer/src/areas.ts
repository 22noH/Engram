// 3영역 + Wiki 네비 탭. Team은 flag on일 때만. Wiki는 항상.
export function areaTabs(teamChat: boolean): ('chat' | 'code' | 'team' | 'wiki')[] {
  return teamChat ? ['chat', 'team', 'code', 'wiki'] : ['chat', 'code', 'wiki'];
}
