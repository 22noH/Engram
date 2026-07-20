import { render, fireEvent } from '@testing-library/react';
import { Nav } from './Nav';

afterEach(() => { vi.restoreAllMocks(); });

it('S2: 멤버·그룹·채널 활성화(disabled 클래스 없음)+클릭 시 onNavigate', () => {
  const onNavigate = vi.fn();
  const { container } = render(
    <Nav serverName="Our Team" address="127.0.0.1:47800" active="overview" onNavigate={onNavigate} role="owner" />,
  );
  const items = Array.from(container.querySelectorAll('.nitem'));
  const find = (text: string) => items.find((el) => el.textContent?.includes(text)) as HTMLElement;

  for (const [label, key] of [['Members', 'members'], ['Groups', 'groups'], ['Channels', 'channels']] as const) {
    const item = find(label);
    expect(item.className).not.toContain('disabled');
    fireEvent.click(item);
    expect(onNavigate).toHaveBeenCalledWith(key);
  }

  // 나머지는 여전히 비활성.
  expect(find('Models').className).toContain('disabled');
});
