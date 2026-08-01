import { PermissionFence } from './permission-fence';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const persona = (over: any = {}) => ({ name: 'Trend', role: '', brain: 'claude', tools: ['WebSearch', 'Bash'], invocation: ['summon'], prompt: '', ...over });

function tmpFence(cfg: any): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-fence-'));
  const p = path.join(dir, 'permissions.json');
  if (cfg) fs.writeFileSync(p, JSON.stringify(cfg));
  return p;
}

it('persona.tools ∩ allow.tools 만 허용', async () => {
  const fence = new PermissionFence(tmpFence({ default: 'deny', allow: { tools: { Trend: ['WebSearch'] }, writePaths: [], denyPaths: [] } }));
  await fence.load();
  expect(fence.allowedTools(persona() as any)).toEqual(['WebSearch']); // Bash는 허용목록에 없어 탈락
});

it('claude 하네스가 아니면 도구 0', async () => {
  const fence = new PermissionFence(tmpFence({ default: 'deny', allow: { tools: { Trend: ['WebSearch'] }, writePaths: [], denyPaths: [] } }));
  await fence.load();
  expect(fence.allowedTools(persona({ brain: 'gemini' }) as any)).toEqual([]);
});

it('설정 파일 없으면 default-deny(도구 0)', async () => {
  const fence = new PermissionFence(tmpFence(null));
  await fence.load();
  expect(fence.allowedTools(persona() as any)).toEqual([]);
});

it('spawnFlags: denyPaths에 있는 writePath는 --add-dir에서 제외', async () => {
  const fence = new PermissionFence(tmpFence({ default: 'deny', allow: { tools: { Trend: ['WebSearch'] }, writePaths: ['C:/ok', 'C:/danger'], denyPaths: ['C:/danger'] } }));
  await fence.load();
  const flags = fence.spawnFlags(persona({ tools: ['WebSearch'] }) as any);
  expect(flags).toContain('--allowedTools');
  expect(flags).toContain('WebSearch');
  expect(flags).toContain('C:/ok');
  expect(flags).not.toContain('C:/danger');
});

it('spawnFlags: 허용 도구 없으면 빈 배열', async () => {
  const fence = new PermissionFence(tmpFence({ default: 'deny', allow: { tools: {}, writePaths: ['C:/ok'], denyPaths: [] } }));
  await fence.load();
  expect(fence.spawnFlags(persona() as any)).toEqual([]);
});

it('spawnFlags: denyPath 하위 writePath도 --add-dir에서 제외(완전일치 아님)', async () => {
  const fence = new PermissionFence(tmpFence({ default: 'deny', allow: { tools: { Trend: ['WebSearch'] }, writePaths: ['C:/engram/plugins', 'C:/ok'], denyPaths: ['C:/engram'] } }));
  await fence.load();
  const flags = fence.spawnFlags(persona({ tools: ['WebSearch'] }) as any);
  expect(flags).toContain('C:/ok');
  expect(flags).not.toContain('C:/engram/plugins'); // engram 하위 → codingFlags·assertWritable과 동일하게 제외
});

it('load: 깨진 JSON도 default-deny로 폴백', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-fence-'));
  const p = path.join(dir, 'permissions.json');
  fs.writeFileSync(p, 'not json{{{');
  const fence = new PermissionFence(p);
  await fence.load();
  expect(fence.allowedTools(persona() as any)).toEqual([]);
});

it('assertWritable는 denyPaths 내 타깃을 거부', () => {
  const f = new PermissionFence('x');
  (f as any).cfg = { default: 'deny', allow: { tools: {}, writePaths: ['C:/proj'], denyPaths: ['C:/engram'] } };
  expect(() => f.assertWritable('C:/engram')).toThrow();
  expect(() => f.assertWritable('C:/proj')).not.toThrow();
  expect(() => f.assertWritable('C:/other')).toThrow(); // writePaths 밖
});

it('assertWritable는 denyPath 하위 디렉터리도 거부, writePath 하위는 허용', () => {
  const f = new PermissionFence('x');
  (f as any).cfg = { default: 'deny', allow: { tools: {}, writePaths: ['C:/proj'], denyPaths: ['C:/engram'] } };
  expect(() => f.assertWritable('C:/engram/src/main.ts')).toThrow(); // deny 하위
  expect(() => f.assertWritable('C:/proj/sub/a.ts')).not.toThrow();   // write 하위 허용
  expect(() => f.assertWritable('C:/PROJ')).not.toThrow();            // Windows 대소문자 무감지
});

it('engramRoot 하드 백스톱: 빈 설정이어도 engramRoot 내부 경로는 항상 거부', () => {
  // 설정이 완전히 비어있어도(denyPaths=[]) engramRoot를 넘기면 해당 경로·하위 모두 거부.
  const root = 'C:/engram-repo';
  const f = new PermissionFence('x', root);
  // cfg는 EMPTY() 기본값(denyPaths=[], writePaths=[])
  expect(() => f.assertWritable('C:/engram-repo')).toThrow('Engram 자기 저장소는 수정 불가(자기수정 차단)');
  expect(() => f.assertWritable('C:/engram-repo/src/agent-layer/foo.ts')).toThrow('Engram 자기 저장소는 수정 불가(자기수정 차단)');
  // 자동모드: writePaths 비어 있으면 백스톱 밖 경로는 허용(명시 타깃 = 동의).
  expect(() => f.assertWritable('C:/other-proj')).not.toThrow();
});

it('assertWritable: 시스템 폴더는 설정 무관 항상 거부', () => {
  const f = new PermissionFence('x');
  (f as any).cfg = { default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [] } };
  expect(() => f.assertWritable('C:/Windows/System32')).toThrow('시스템 폴더');
  expect(() => f.assertWritable('C:/Program Files/foo')).toThrow('시스템 폴더');
});

it('assertWritable: writePaths 비어 있으면 자동 허용, 지정되면 엄격 allowlist', () => {
  const auto = new PermissionFence('x', 'C:/engram');
  (auto as any).cfg = { default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [] } };
  expect(() => auto.assertWritable('C:/Users/User/proj')).not.toThrow(); // 자동: 백스톱 밖 허용
  const strict = new PermissionFence('x');
  (strict as any).cfg = { default: 'deny', allow: { tools: {}, writePaths: ['C:/proj'], denyPaths: [] } };
  expect(() => strict.assertWritable('C:/proj/sub')).not.toThrow();
  expect(() => strict.assertWritable('C:/other')).toThrow('writePaths 밖'); // 지정됐으니 밖 거부
});

it('codingAutoFlags: 표준 toolset + 백스톱 밖 폴더만 add-dir, 자동모드는 Bash 포함(2026-08-01 개방)', () => {
  const f = new PermissionFence('x', 'C:/engram');
  (f as any).cfg = { default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [] } };
  const flags = f.codingAutoFlags(['C:/proj', 'C:/engram/x']);
  expect(flags).toContain('--allowedTools');
  expect(flags.join(',')).toContain('Edit'); // 파일 도구
  expect(flags.join(',')).toContain('Bash'); // 자동모드(전역 기본) — git 등 실작업 가능
  expect(flags).toContain('--add-dir');
  expect(flags).toContain('C:/proj');
  expect(flags).not.toContain('C:/engram/x'); // 백스톱(자기 repo 하위) 제외
});

it('codingAutoFlags: restricted는 허용목록 명령만 Bash(<cmd>:*) 스코프, plan/files는 Bash 없음', () => {
  const f = new PermissionFence('x');
  (f as any).cfg = { default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [], commands: ['git', 'npm'] } };
  const restricted = f.codingAutoFlags(['C:/proj'], 'restricted' as any).join(',');
  expect(restricted).toContain('Bash(git:*)');
  expect(restricted).toContain('Bash(npm:*)');
  expect(restricted).not.toContain('Bash,'); // 전체 Bash는 아님(스코프만)
  const plan = f.codingAutoFlags(['C:/proj'], 'plan' as any).join(',');
  expect(plan).not.toContain('Bash');
  const files = f.codingAutoFlags(['C:/proj'], 'files' as any).join(',');
  expect(files).not.toContain('Bash');
});

it('assertWritable: C:/ProgramData도 시스템 폴더로 거부', () => {
  const f = new PermissionFence('x');
  (f as any).cfg = { default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [] } };
  expect(() => f.assertWritable('C:/ProgramData/foo')).toThrow('시스템 폴더');
});

describe('assertCodingWrite (API 코딩 쓰기 판정)', () => {
  it('엔그램 자기 저장소는 백스톱으로 거부', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-root-'));
    try {
      const fence = new PermissionFence(tmpFence(null), root);
      await fence.load();
      expect(() => fence.assertCodingWrite(path.join(root, 'src/x.ts'), [])).toThrow();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('projectWritePaths 지정 시 그 안이면 통과, 밖이면 throw', async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-proj-'));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-other-'));
    try {
      const fence = new PermissionFence(tmpFence(null)); // engramRoot 없음
      await fence.load();
      expect(() => fence.assertCodingWrite(path.join(proj, 'a.ts'), [proj])).not.toThrow();
      expect(() => fence.assertCodingWrite(path.join(other, 'a.ts'), [proj])).toThrow('쓰기 스코프 밖');
    } finally { fs.rmSync(proj, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); }
  });

  it('projectWritePaths 비면 백스톱 밖은 통과(자동모드)', async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-proj2-'));
    try {
      const fence = new PermissionFence(tmpFence(null));
      await fence.load();
      expect(() => fence.assertCodingWrite(path.join(proj, 'a.ts'), [])).not.toThrow();
    } finally { fs.rmSync(proj, { recursive: true, force: true }); }
  });
});

describe('commandMode / assertCommandAllowed (Phase 8b-2)', () => {
  it('기본(미지정) = auto → 아무 명령이나 통과 + shellEnabled true', async () => {
    const fence = new PermissionFence(tmpFence({ default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [] } }));
    await fence.load();
    expect(fence.shellEnabled()).toBe(true);
    expect(() => fence.assertCommandAllowed('rm -rf /')).not.toThrow(); // auto=제한 안 함
  });

  it('off → shellEnabled false + assertCommandAllowed throw', async () => {
    const fence = new PermissionFence(tmpFence({ default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [], commandMode: 'off' } }));
    await fence.load();
    expect(fence.shellEnabled()).toBe(false);
    expect(() => fence.assertCommandAllowed('npm test')).toThrow();
  });

  it('allowlist → 기본목록 통과·목록 밖 throw·연산자 throw', async () => {
    const fence = new PermissionFence(tmpFence({ default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [], commandMode: 'allowlist' } }));
    await fence.load();
    expect(() => fence.assertCommandAllowed('npm test')).not.toThrow(); // 기본목록에 npm
    expect(() => fence.assertCommandAllowed('curl http://x')).toThrow(); // 목록 밖
    expect(() => fence.assertCommandAllowed('msbuild.exe App.sln')).not.toThrow(); // .exe 정규화
    // 체이닝/치환/개행 전부 거부(shell:true라 개행도 POSIX 명령 구분자).
    for (const bad of ['npm test && x', 'npm test | x', 'npm test ; x', 'npm test > f', 'npm test `x`', 'npm test $(x)', 'npm test\ncurl evil']) {
      expect(() => fence.assertCommandAllowed(bad)).toThrow('연산자');
    }
  });

  it('allowlist + 사용자 지정 commands → 그것만', async () => {
    const fence = new PermissionFence(tmpFence({ default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [], commandMode: 'allowlist', commands: ['pytest'] } }));
    await fence.load();
    expect(() => fence.assertCommandAllowed('pytest -q')).not.toThrow();
    expect(() => fence.assertCommandAllowed('npm test')).toThrow(); // 지정 목록에 npm 없음
  });
});

// ─── 채널 권한 모드(코드 채널별) ────────────────────────────────────────────────
// 핵심: 게이트가 "부팅 시 읽은 전역 설정"이 아니라 "이번 턴에 넘어온 모드"를 본다.
// mode 미지정(undefined) = 전역 설정 그대로(=기존 동작, 회귀 0).
describe('permMode(채널 권한 모드) — 턴 단위 주입', () => {
  it('plan(계획만): 파일 쓰기도 명령도 전부 거부', async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-plan-'));
    try {
      const fence = new PermissionFence(tmpFence(null)); // 전역=auto(가장 느슨) — 그래도 plan이 이긴다
      await fence.load();
      expect(() => fence.assertWritable(path.join(proj, 'a.ts'), 'plan')).toThrow();
      expect(() => fence.assertCodingWrite(path.join(proj, 'a.ts'), [proj], 'plan')).toThrow();
      expect(fence.shellEnabled('plan')).toBe(false);
      expect(() => fence.assertCommandAllowed('npm test', 'plan')).toThrow();
    } finally { fs.rmSync(proj, { recursive: true, force: true }); }
  });

  it('files(파일만): 파일 쓰기는 되고 명령 실행은 거부', async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-files-'));
    try {
      const fence = new PermissionFence(tmpFence(null));
      await fence.load();
      expect(() => fence.assertCodingWrite(path.join(proj, 'a.ts'), [proj], 'files')).not.toThrow();
      expect(fence.shellEnabled('files')).toBe(false);
      expect(() => fence.assertCommandAllowed('npm test', 'files')).toThrow();
    } finally { fs.rmSync(proj, { recursive: true, force: true }); }
  });

  it('restricted(제한): 승인된 명령만 — 전역이 auto여도 목록 밖은 거부', async () => {
    const fence = new PermissionFence(tmpFence({ default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [], commandMode: 'auto' } }));
    await fence.load();
    expect(fence.shellEnabled('restricted')).toBe(true);
    expect(() => fence.assertCommandAllowed('npm test', 'restricted')).not.toThrow();
    expect(() => fence.assertCommandAllowed('curl http://x', 'restricted')).toThrow();
    expect(() => fence.assertCommandAllowed('npm test && curl x', 'restricted')).toThrow('연산자');
  });

  it('auto(자동): 전역이 off여도 이번 턴은 아무 명령이나 통과(부팅캐시 아님)', async () => {
    const fence = new PermissionFence(tmpFence({ default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [], commandMode: 'off' } }));
    await fence.load();
    expect(fence.shellEnabled()).toBe(false);           // 전역 폴백은 여전히 off
    expect(fence.shellEnabled('auto')).toBe(true);      // 이번 턴은 auto
    expect(() => fence.assertCommandAllowed('rm -rf /tmp/x', 'auto')).not.toThrow();
  });

  it('bypass(권한 무시): writePaths 울타리·프로젝트 스코프 밖도 허용', async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-bp-'));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-bp-out-'));
    try {
      const fence = new PermissionFence(tmpFence({ default: 'deny', allow: { tools: {}, writePaths: [proj], denyPaths: [] } }));
      await fence.load();
      // 기본(모드 미지정)이면 울타리 밖 → 거부
      expect(() => fence.assertCodingWrite(path.join(other, 'a.ts'), [proj])).toThrow();
      // 권한 무시면 같은 경로가 허용된다
      expect(() => fence.assertWritable(path.join(other, 'a.ts'), 'bypass')).not.toThrow();
      expect(() => fence.assertCodingWrite(path.join(other, 'a.ts'), [proj], 'bypass')).not.toThrow();
      expect(() => fence.assertCommandAllowed('anything --x', 'bypass')).not.toThrow();
    } finally { fs.rmSync(proj, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); }
  });

  it('bypass여도 하드 백스톱(자기 저장소·시스템·denyPaths)은 못 뚫는다', () => {
    const f = new PermissionFence('x', 'C:/engram-repo');
    (f as any).cfg = { default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: ['C:/nope'] } };
    expect(() => f.assertWritable('C:/engram-repo/src/x.ts', 'bypass')).toThrow('자기 저장소');
    expect(() => f.assertWritable('C:/Windows/System32', 'bypass')).toThrow('시스템 폴더');
    expect(() => f.assertWritable('C:/nope/x', 'bypass')).toThrow('denyPaths');
  });

  it('모드 미지정이면 전역 설정 그대로(회귀 0)', async () => {
    const fence = new PermissionFence(tmpFence({ default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [], commandMode: 'allowlist' } }));
    await fence.load();
    expect(fence.shellEnabled(undefined)).toBe(true);
    expect(() => fence.assertCommandAllowed('npm test', undefined)).not.toThrow();
    expect(() => fence.assertCommandAllowed('curl x', undefined)).toThrow();
  });
});
