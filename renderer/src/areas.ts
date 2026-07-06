// 3영역 네비 탭 순서/게이팅(순수 — flag on/off 둘 다 단위테스트 가능). Team은 flag on일 때만.
export function areaTabs(teamChat: boolean): ('chat' | 'code' | 'team')[] {
  return teamChat ? ['chat', 'team', 'code'] : ['chat', 'code'];
}
