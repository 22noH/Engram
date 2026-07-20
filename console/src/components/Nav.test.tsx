import { render, fireEvent } from '@testing-library/react';
import { Nav } from './Nav';

afterEach(() => { vi.restoreAllMocks(); });

it('S3: 멤버·그룹·채널·모델·MCP·위키·서버설정·클라이언트배포 활성화(disabled 클래스 없음)+클릭 시 onNavigate', () => {
  const onNavigate = vi.fn();
  const { container } = render(
    <Nav serverName="Our Team" address="127.0.0.1:47800" active="overview" onNavigate={onNavigate} role="owner" />,
  );
  const items = Array.from(container.querySelectorAll('.nitem'));
  const find = (text: string) => items.find((el) => el.textContent?.includes(text)) as HTMLElement;

  const enabledPairs = [
    ['Members', 'members'], ['Groups', 'groups'], ['Channels', 'channels'],
    ['Models', 'models'], ['MCP', 'mcp'], ['Wiki', 'wiki'],
    ['Server settings', 'settings'], ['Client deploy', 'deploy'],
  ] as const;
  for (const [label, key] of enabledPairs) {
    const item = find(label);
    expect(item.className).not.toContain('disabled');
    fireEvent.click(item);
    expect(onNavigate).toHaveBeenCalledWith(key);
  }

  // 상태·로그만 여전히 비활성(S4).
  expect(find('Status & logs').className).toContain('disabled');
});
