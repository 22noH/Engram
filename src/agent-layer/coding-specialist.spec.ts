import { CodingSpecialist } from './coding-specialist';

describe('CodingSpecialist', () => {
  const registry = { get: (n: string) => n === 'Dev' ? { name: 'Dev', brain: 'claude', tools: ['Bash','Edit','Write'], prompt: 'You code.' } : undefined } as any;
  const fence = { codingFlags: () => ['--allowedTools', 'Bash,Edit,Write', '--add-dir', 'C:/proj'] } as any;
  const project = { targetPath: 'C:/proj', writePaths: ['C:/proj'] } as any;
  const logger = { warn() {}, log() {} } as any;

  it('페르소나+티켓을 두뇌에 넘기고 cwd·플래그로 호출', async () => {
    const captured: any = {};
    const brain = { complete: (p: string, _c: any, opts: any) => { captured.prompt = p; captured.opts = opts; return Promise.resolve({ text: '작업함', costUsd: 0, isError: false }); } };
    const spec = new CodingSpecialist(registry, fence, () => brain as any, logger);
    const out = await spec.work('Dev', { id: 'tk1', area: 'src/a', instruction: '로그인 고쳐', status: 'PENDING', attempts: 0, gate: null }, project);
    expect(out).toBe('작업함');
    expect(captured.opts.cwd).toBe('C:/proj');
    expect(captured.opts.extraArgs).toContain('--allowedTools');
    expect(captured.prompt).toContain('로그인 고쳐');
  });

  it('직전 게이트 실패가 있으면 프롬프트에 실패내용 포함', async () => {
    const captured: any = {};
    const brain = { complete: (p: string) => { captured.prompt = p; return Promise.resolve({ text: 'x', costUsd: 0, isError: false }); } };
    const spec = new CodingSpecialist(registry, fence, () => brain as any, logger);
    await spec.work('Dev', { id: 'tk1', area: 'src/a', instruction: 'i', status: 'PENDING', attempts: 1, gate: { pass: false, output: '테스트 빨강' } }, project);
    expect(captured.prompt).toContain('테스트 빨강');
  });

  it('알 수 없는 페르소나는 throw', async () => {
    const spec = new CodingSpecialist(registry, fence, () => ({ complete: () => Promise.resolve({ text: '', costUsd: 0, isError: false }) }) as any, logger);
    await expect(spec.work('Ghost', {} as any, project)).rejects.toThrow();
  });

  it('두뇌 isError면 throw', async () => {
    const brain = { complete: () => Promise.resolve({ text: '', costUsd: 0, isError: true }) };
    const spec = new CodingSpecialist(registry, fence, () => brain as any, logger);
    await expect(spec.work('Dev', { id: 'tk1', area: 'src/a', instruction: 'x', status: 'PENDING', attempts: 0, gate: null }, project)).rejects.toThrow();
  });
});
