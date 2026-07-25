import { CodingSpecialist, CODING_RULES_DEFAULT } from './coding-specialist';
import { PermissionFence } from './permission-fence';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// 진짜 PermissionFence로 모드별 차단을 실증하기 위한 헬퍼(permission-fence.spec.ts와 동일 결).
function fencePath(cfg: any): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-cs-fence-'));
  const p = path.join(dir, 'permissions.json');
  if (cfg) fs.writeFileSync(p, JSON.stringify(cfg));
  return p;
}
let sharedTmp: string | undefined;
function tmpDir(): string {
  if (!sharedTmp) sharedTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-cs-proj-')).replace(/\\/g, '/');
  return sharedTmp;
}

describe('CodingSpecialist', () => {
  const registry = { get: (n: string) => n === 'Dev' ? { name: 'Dev', brain: 'claude', tools: ['Bash','Edit','Write'], prompt: 'You code.' } : undefined } as any;
  const fence = { codingAutoFlags: () => ['--allowedTools', 'Bash,Edit,Write', '--add-dir', 'C:/proj'], shellEnabled: () => false } as any;
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
    expect(captured.opts.extraArgs).toContain('--permission-mode'); // 자동모드 acceptEdits
    expect(captured.opts.extraArgs).toContain('acceptEdits');
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

  it('coding-rules default is English', () => {
    expect(/[가-힣]/.test(CODING_RULES_DEFAULT)).toBe(false);
  });

  it('work() prompt carries english labels + interactive directive', async () => {
    let captured = '';
    const brain2 = { complete: async (p: string) => { captured = p; return { text: 'x', costUsd: 0 }; } };
    const registry2 = { get: () => ({ prompt: 'PERSONA', brain: 'claude' }) };
    const fence2 = { codingAutoFlags: () => [], shellEnabled: () => false };
    const resolveBrain2 = () => brain2;
    const cs = new CodingSpecialist(registry2 as any, fence2 as any, resolveBrain2 as any, { error(){} } as any);
    await cs.work('Coder', { id: 't', area: 'a', instruction: 'do' } as any, { targetPath: 'C:/x', writePaths: [] } as any);
    expect(captured).toContain('# Work area');
    expect(captured).toContain("Respond in the language of the user's latest message.");
  });

  it('brain.complete에 codeGuard(=fence.assertCodingWrite 바인딩)를 함께 넘긴다', async () => {
    const calls: Array<{ target: string; scope: string[] }> = [];
    const fence2 = {
      codingAutoFlags: () => ['--allowedTools', 'Edit', '--add-dir', 'C:/proj'],
      assertCodingWrite: (target: string, scope: string[]) => { calls.push({ target, scope }); },
      shellEnabled: () => false,
    } as any;
    const captured: any = {};
    const brain = { complete: (_p: string, _c: any, opts: any) => { captured.opts = opts; return Promise.resolve({ text: 'ok', costUsd: 0, isError: false }); } };
    const spec = new CodingSpecialist(registry, fence2, () => brain as any, logger);
    await spec.work('Dev', { id: 'tk1', area: 'src/a', instruction: 'i', status: 'PENDING', attempts: 0, gate: null }, project);
    expect(typeof captured.opts.codeGuard).toBe('function');
    expect(captured.opts.cwd).toBe('C:/proj');
    expect(captured.opts.extraArgs).toContain('--allowedTools'); // CLI용도 그대로
    captured.opts.codeGuard('C:/proj/a.ts'); // 호출 시 fence.assertCodingWrite로 위임
    expect(calls).toEqual([{ target: 'C:/proj/a.ts', scope: ['C:/proj'] }]);
  });

  it('shellEnabled면 cmdGuard(=fence.assertCommandAllowed)도 전달', async () => {
    const calls: string[] = [];
    const fence2 = {
      codingAutoFlags: () => ['--allowedTools', 'Edit'],
      assertCodingWrite: () => {},
      shellEnabled: () => true,
      assertCommandAllowed: (cmd: string) => { calls.push(cmd); },
    } as any;
    const captured: any = {};
    const brain = { complete: (_p: string, _c: any, opts: any) => { captured.opts = opts; return Promise.resolve({ text: 'ok', costUsd: 0, isError: false }); } };
    const spec = new CodingSpecialist(registry, fence2, () => brain as any, logger);
    await spec.work('Dev', { id: 'tk1', area: 'src/a', instruction: 'i', status: 'PENDING', attempts: 0, gate: null }, project);
    expect(typeof captured.opts.cmdGuard).toBe('function');
    captured.opts.cmdGuard('npm test');
    expect(calls).toEqual(['npm test']);
  });

  it('shellEnabled=false면 cmdGuard 미전달(off)', async () => {
    const fence2 = { codingAutoFlags: () => [], assertCodingWrite: () => {}, shellEnabled: () => false, assertCommandAllowed: () => {} } as any;
    const captured: any = {};
    const brain = { complete: (_p: string, _c: any, opts: any) => { captured.opts = opts; return Promise.resolve({ text: 'ok', costUsd: 0, isError: false }); } };
    const spec = new CodingSpecialist(registry, fence2, () => brain as any, logger);
    await spec.work('Dev', { id: 'tk1', area: 'src/a', instruction: 'i', status: 'PENDING', attempts: 0, gate: null }, project);
    expect(captured.opts.cmdGuard).toBeUndefined();
  });

  it('brainOverride 지정 → persona.brain 조회를 건너뛰고 그 두뇌로 부른다(Task 2, 채널 두뇌 위임)', async () => {
    let personaCalls = 0;
    const namedCalls: string[] = [];
    const namedBrain = { complete: (p: string) => { namedCalls.push(p); return Promise.resolve({ text: '채널두뇌답', costUsd: 0, isError: false }); } };
    const resolveBrain = () => { personaCalls++; return { complete: () => Promise.resolve({ text: '기본답', costUsd: 0, isError: false }) } as any; };
    const spec = new CodingSpecialist(registry, fence, resolveBrain as any, logger);
    const out = await spec.work('Dev', { id: 'tk1', area: 'src/a', instruction: '로그인 고쳐', status: 'PENDING', attempts: 0, gate: null }, project, undefined, namedBrain as any);
    expect(out).toBe('채널두뇌답');
    expect(namedCalls).toHaveLength(1);
    expect(personaCalls).toBe(0); // persona.brain 조회(resolveBrain)는 호출되지 않아야 한다
  });

  it('brainOverride 미지정 → 기존 동작(persona.brain 조회) 그대로(회귀 0)', async () => {
    const captured: any = {};
    const brain = { complete: (p: string) => { captured.prompt = p; return Promise.resolve({ text: '작업함', costUsd: 0, isError: false }); } };
    const spec = new CodingSpecialist(registry, fence, () => brain as any, logger);
    const out = await spec.work('Dev', { id: 'tk1', area: 'src/a', instruction: '로그인 고쳐', status: 'PENDING', attempts: 0, gate: null }, project);
    expect(out).toBe('작업함');
  });

  // ─── 채널 권한 모드(permMode) 관통 ────────────────────────────────────────────
  // 게이트가 "부팅 시 캐시한 전역값"이 아니라 "이번 턴에 넘어온 모드"를 보는지 — 주입 인자로 실증.
  describe('permMode 관통', () => {
    const ticket = { id: 'tk1', area: 'src/a', instruction: 'i', status: 'PENDING', attempts: 0, gate: null } as any;

    it('permMode를 shellEnabled·codeGuard·cmdGuard 판정에 그대로 넘긴다', async () => {
      const seen: any = { shell: [], code: [], cmd: [] };
      const fence2 = {
        codingAutoFlags: () => ['--allowedTools', 'Edit'],
        assertCodingWrite: (t: string, s: string[], m?: string) => { seen.code.push([t, s, m]); },
        shellEnabled: (m?: string) => { seen.shell.push(m); return true; },
        assertCommandAllowed: (c: string, m?: string) => { seen.cmd.push([c, m]); },
      } as any;
      const captured: any = {};
      const brain = { complete: (_p: string, _c: any, opts: any) => { captured.opts = opts; return Promise.resolve({ text: 'ok', costUsd: 0, isError: false }); } };
      const spec = new CodingSpecialist(registry, fence2, () => brain as any, logger);
      await spec.work('Dev', ticket, project, undefined, undefined, 'restricted');
      expect(seen.shell).toEqual(['restricted']);
      captured.opts.codeGuard('C:/proj/a.ts');
      captured.opts.cmdGuard('npm test');
      expect(seen.code).toEqual([['C:/proj/a.ts', ['C:/proj'], 'restricted']]);
      expect(seen.cmd).toEqual([['npm test', 'restricted']]);
    });

    it('files(파일만): 진짜 fence로 — 파일 쓰기는 통과, 명령 실행 도구는 아예 미노출', async () => {
      const fence2 = new PermissionFence(fencePath(null)); // 전역 = auto(가장 느슨)
      await fence2.load();
      const captured: any = {};
      const brain = { complete: (_p: string, _c: any, opts: any) => { captured.opts = opts; return Promise.resolve({ text: 'ok', costUsd: 0, isError: false }); } };
      const spec = new CodingSpecialist(registry, fence2 as any, () => brain as any, logger);
      const proj = { targetPath: tmpDir(), writePaths: [] } as any;
      await spec.work('Dev', ticket, proj, undefined, undefined, 'files');
      expect(captured.opts.cmdGuard).toBeUndefined(); // 명령 실행 = 거부(도구 자체가 안 붙는다)
      expect(() => captured.opts.codeGuard(`${proj.targetPath}/a.ts`)).not.toThrow(); // 파일 수정은 허용
    });

    it('plan(계획만): 진짜 fence로 — 파일 쓰기도 거부 + CLI 플래그에 쓰기 도구 없음', async () => {
      const fence2 = new PermissionFence(fencePath(null));
      await fence2.load();
      const captured: any = {};
      const brain = { complete: (_p: string, _c: any, opts: any) => { captured.opts = opts; return Promise.resolve({ text: 'ok', costUsd: 0, isError: false }); } };
      const spec = new CodingSpecialist(registry, fence2 as any, () => brain as any, logger);
      const proj = { targetPath: tmpDir(), writePaths: [] } as any;
      await spec.work('Dev', ticket, proj, undefined, undefined, 'plan');
      expect(captured.opts.cmdGuard).toBeUndefined();
      expect(() => captured.opts.codeGuard(`${proj.targetPath}/a.ts`)).toThrow(/계획만/);
      const args: string[] = captured.opts.extraArgs;
      expect(args.join(',')).not.toContain('Edit');         // CLI 두뇌에도 쓰기 도구 미노출
      expect(args.join(',')).not.toContain('Write');
      expect(args).not.toContain('acceptEdits');            // 자동 편집 승인도 안 붙인다
      expect(args.join(',')).toContain('Read');             // 읽기는 된다
    });

    it('bypass(권한 무시): 진짜 fence로 — 프로젝트 쓰기 스코프 밖도 허용', async () => {
      const fence2 = new PermissionFence(fencePath(null));
      await fence2.load();
      const captured: any = {};
      const brain = { complete: (_p: string, _c: any, opts: any) => { captured.opts = opts; return Promise.resolve({ text: 'ok', costUsd: 0, isError: false }); } };
      const spec = new CodingSpecialist(registry, fence2 as any, () => brain as any, logger);
      const proj = { targetPath: tmpDir(), writePaths: [tmpDir()] } as any;
      const outside = `${tmpDir()}/outside/a.ts`;
      await spec.work('Dev', ticket, proj, undefined, undefined, 'bypass');
      expect(() => captured.opts.codeGuard(outside)).not.toThrow();
      expect(typeof captured.opts.cmdGuard).toBe('function'); // 명령도 자동
    });

    it('permMode 미지정이면 기존 동작 그대로(전역 설정 폴백, 회귀 0)', async () => {
      const seen: any[] = [];
      const fence2 = {
        codingAutoFlags: () => [],
        assertCodingWrite: (t: string, s: string[], m?: string) => { seen.push(m); },
        shellEnabled: (m?: string) => { seen.push(m); return false; },
        assertCommandAllowed: () => {},
      } as any;
      const captured: any = {};
      const brain = { complete: (_p: string, _c: any, opts: any) => { captured.opts = opts; return Promise.resolve({ text: 'ok', costUsd: 0, isError: false }); } };
      const spec = new CodingSpecialist(registry, fence2, () => brain as any, logger);
      await spec.work('Dev', ticket, project);
      captured.opts.codeGuard('C:/proj/a.ts');
      expect(seen).toEqual([undefined, undefined]); // 어느 게이트에도 모드가 안 붙는다
    });
  });
});
