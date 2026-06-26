import { CliGateway } from './cli.gateway';

describe('CliGateway', () => {
  let writes: string[];
  let spy: jest.SpyInstance;
  beforeEach(() => {
    writes = [];
    spy = jest.spyOn(process.stdout, 'write').mockImplementation((s: any) => { writes.push(String(s)); return true; });
  });
  afterEach(() => spy.mockRestore());

  it('ask 모드: 인수를 CoreMessage로 만들어 route하고 스트림을 stdout에 쓴다', async () => {
    const orch = { route: jest.fn(async (_m, onChunk?: (t: string) => void) => { onChunk?.('답변'); return '답변'; }) } as any;
    await new CliGateway(orch).run(['ask', '안녕', '세계']);
    expect(orch.route).toHaveBeenCalledWith({ text: '안녕 세계', userId: 'default' }, expect.any(Function));
    expect(writes.join('')).toContain('답변');
  });

  it('알 수 없는 인수는 사용법을 출력한다', async () => {
    const orch = { route: jest.fn() } as any;
    await new CliGateway(orch).run(['bogus']);
    expect(orch.route).not.toHaveBeenCalled();
    expect(writes.join('')).toContain('사용법');
  });
});
