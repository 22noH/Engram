// second-instance(스펙 §7) 시 기존 창을 포커스하는 순수 로직만 분리(main.ts는 BrowserWindow를
// 넘겨주는 얇은 글루). 아이콘 재클릭 = 최소화면 복원 → 보이기 → 포커스.
export interface MinimalWindow {
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export function focusOrRestore(win: MinimalWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
