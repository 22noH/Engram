import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CliGateway } from './cli.gateway';
import { PathResolver } from '../pal/path-resolver';

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
    await new CliGateway(orch, {} as any, {} as any).run(['ask', '안녕', '세계']);
    expect(orch.route).toHaveBeenCalledWith({ text: '안녕 세계', userId: 'default' }, expect.any(Function));
    expect(writes.join('')).toContain('답변');
  });

  it('알 수 없는 인수는 사용법을 출력한다', async () => {
    const orch = { route: jest.fn() } as any;
    await new CliGateway(orch, {} as any, {} as any).run(['bogus']);
    expect(orch.route).not.toHaveBeenCalled();
    expect(writes.join('')).toContain('사용법');
  });

  it('digest 모드: orchestrator.digest를 호출하고 결과를 출력한다', async () => {
    const orch = { route: jest.fn(), digest: jest.fn().mockResolvedValue({ extracted: 3, gated: 2, proposed: 1 }) } as any;
    await new CliGateway(orch, {} as any, {} as any).run(['digest']);
    expect(orch.digest).toHaveBeenCalled();
    expect(writes.join('')).toContain('제안');
  });

  it('team 모드: orchestrator.collaborate를 호출하고 결과를 출력한다', async () => {
    const orch = { collaborate: jest.fn().mockResolvedValue('협업 결과') } as any;
    await new CliGateway(orch, {} as any, {} as any).run(['team', 'Alice,Bob', '전략', '논의']);
    expect(orch.collaborate).toHaveBeenCalledWith('전략 논의', ['Alice', 'Bob'], 'default');
    expect(writes.join('')).toContain('협업 결과');
  });

  describe('meeting 명령', () => {
    let tmpDir: string;
    let paths: PathResolver;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-cli-'));
      paths = new PathResolver(tmpDir);
    });

    it('meeting list: 빈 목록을 출력한다', async () => {
      const orch = {} as any;
      await new CliGateway(orch, {} as any, {} as any, paths).run(['meeting', 'list']);
      expect(writes.join('')).toBe('\n');
    });

    it('meeting add/list/remove 라이프사이클', async () => {
      const orch = {} as any;
      const gw = new CliGateway(orch, {} as any, {} as any, paths);
      await gw.run(['meeting', 'add', 'weekly', '0 9 * * 1', 'Alice,Bob', '주간', '보고']);
      expect(writes.join('')).toContain('회의 추가: weekly');
      writes.length = 0;

      await gw.run(['meeting', 'list']);
      expect(writes.join('')).toContain('weekly');
      writes.length = 0;

      await gw.run(['meeting', 'remove', 'weekly']);
      expect(writes.join('')).toContain('회의 삭제: weekly');
      writes.length = 0;

      await gw.run(['meeting', 'list']);
      expect(writes.join('')).toBe('\n');
    });

    it('meeting run: meetingEngine.run을 호출하고 회의록 slug를 출력한다', async () => {
      const orch = {} as any;
      const engine = { run: jest.fn().mockResolvedValue({ minutesSlug: 'meeting-weekly-2026-06-27', decisionId: 'dec-1' }) } as any;
      const gw = new CliGateway(orch, {} as any, {} as any, paths, engine);
      // add a meeting first
      const configDir = paths.getConfigDir();
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'meetings.json'), JSON.stringify([{ name: 'weekly', schedule: '0 9 * * 1', roster: ['Alice'], agenda: '주간 보고' }]));
      await gw.run(['meeting', 'run', 'weekly']);
      expect(engine.run).toHaveBeenCalled();
      expect(writes.join('')).toContain('meeting-weekly-2026-06-27');
    });

    it('meeting run: 없는 회의명이면 "회의 없음" 출력', async () => {
      const orch = {} as any;
      const engine = { run: jest.fn() } as any;
      const gw = new CliGateway(orch, {} as any, {} as any, paths, engine);
      await gw.run(['meeting', 'run', 'nonexistent']);
      expect(engine.run).not.toHaveBeenCalled();
      expect(writes.join('')).toContain('회의 없음');
    });
  });

  it('engram pause는 orchestrator.setRunState(paused) 호출', async () => {
    const calls: string[] = [];
    const orch = { setRunState: (s: string) => calls.push(s) } as any;
    const gw = new CliGateway(orch, {} as any, {} as any);
    await gw.run(['pause']);
    expect(calls).toEqual(['paused']);
  });

  it('engram stop은 stopped', async () => {
    const calls: string[] = [];
    const gw = new CliGateway({ setRunState: (s: string) => calls.push(s) } as any, {} as any, {} as any);
    await gw.run(['stop']);
    expect(calls).toEqual(['stopped']);
  });

  it('engram resume은 running', async () => {
    const calls: string[] = [];
    const gw = new CliGateway({ setRunState: (s: string) => calls.push(s) } as any, {} as any, {} as any);
    await gw.run(['resume']);
    expect(calls).toEqual(['running']);
  });

  it('insights run은 orchestrator.insight를 호출하고 생성 결과를 출력', async () => {
    const out: string[] = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((s: any) => { out.push(String(s)); return true; });
    const orch = { insight: async () => ({ date: '2026-06-28', metrics: { queryCount: 3 } as any, report: '도커 집중' }) };
    const gw = new CliGateway(orch as any, {} as any, {} as any);
    await gw.run(['insights', 'run']);
    expect(out.join('')).toContain('2026-06-28');
    (process.stdout.write as any).mockRestore();
  });

  it('insights는 InsightStore.latest를 출력(없으면 안내)', async () => {
    const out: string[] = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((s: any) => { out.push(String(s)); return true; });
    const store = { latest: async () => null };
    const gw = new CliGateway({} as any, {} as any, {} as any, undefined, undefined, store as any);
    await gw.run(['insights']);
    expect(out.join('')).toContain('아직');
    (process.stdout.write as any).mockRestore();
  });

  it('service는 알 수 없는/빈 동사에 사용법을 출력', async () => {
    const out: string[] = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((s: any) => { out.push(String(s)); return true; });
    const gw = new CliGateway({} as any, {} as any, {} as any);
    await gw.run(['service', '봉봉']);            // 미지원 동사 → 사용법(슈퍼바이저 미생성, OS 무접촉)
    expect(out.join('')).toContain('engram service');
    (process.stdout.write as any).mockRestore();
  });
});
