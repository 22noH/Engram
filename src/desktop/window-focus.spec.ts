import { focusOrRestore, MinimalWindow } from './window-focus';

function mockWin(minimized: boolean): MinimalWindow & { restore: jest.Mock; show: jest.Mock; focus: jest.Mock } {
  return {
    isMinimized: () => minimized,
    restore: jest.fn(),
    show: jest.fn(),
    focus: jest.fn(),
  };
}

describe('focusOrRestore', () => {
  it('최소화 상태면 restore부터 호출한다', () => {
    const win = mockWin(true);
    focusOrRestore(win);
    expect(win.restore).toHaveBeenCalledTimes(1);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  it('최소화 상태가 아니면 restore를 호출하지 않는다', () => {
    const win = mockWin(false);
    focusOrRestore(win);
    expect(win.restore).not.toHaveBeenCalled();
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });
});
