import { render, screen, fireEvent } from '@testing-library/react';
import { ActionButtons } from './ActionButtons';

it('confirm 없는 버튼은 즉시 onSend(send)한다', () => {
  const sent: string[] = [];
  render(<ActionButtons actions={[{ label: '취소', send: '취소' }]} onSend={(t) => sent.push(t)} />);
  fireEvent.click(screen.getByText('취소'));
  expect(sent).toEqual(['취소']);
});

it('confirm 있는 버튼은 확인해야 onSend, 거부하면 안 보낸다', () => {
  const sent: string[] = [];
  const spy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<ActionButtons actions={[{ label: '✅ 승인', send: '승인', confirm: '시작?' }]} onSend={(t) => sent.push(t)} />);
  fireEvent.click(screen.getByText('✅ 승인'));
  expect(sent).toEqual([]);            // 거부 → 미전송
  spy.mockReturnValue(true);
  fireEvent.click(screen.getByText('✅ 승인'));
  expect(sent).toEqual(['승인']);      // 확인 → 전송
  spy.mockRestore();
});

it('한 번 전송하면 버튼이 비활성화된다', () => {
  const sent: string[] = [];
  render(<ActionButtons actions={[{ label: '취소', send: '취소' }]} onSend={(t) => sent.push(t)} />);
  const btn = screen.getByText('취소') as HTMLButtonElement;
  fireEvent.click(btn);
  fireEvent.click(btn);
  expect(sent).toEqual(['취소']);      // 중복 클릭 무시
  expect(btn.disabled).toBe(true);
});
