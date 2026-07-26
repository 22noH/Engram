import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BOOT_STEPS,
  bootProgressPath,
  bootSplashText,
  bootStageStep,
  formatElapsed,
  isBootStalled,
  isFreshBootProgress,
  markBootStage,
  readBootProgress,
  writeBootProgress,
} from './boot-progress';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-boot-'));
}

describe('boot-progress 파일 왕복', () => {
  it('쓴 단계를 그대로 읽는다(state/boot-progress.json)', () => {
    const dir = tmpDir();
    writeBootProgress(dir, { stage: 'index', at: 1000, startedAt: 500, pid: 7, done: 3, total: 12 });
    expect(fs.existsSync(bootProgressPath(dir))).toBe(true);
    expect(readBootProgress(dir)).toEqual({ stage: 'index', at: 1000, startedAt: 500, pid: 7, done: 3, total: 12 });
  });

  it('파일이 없거나 깨졌거나 모르는 단계면 null(부팅을 막지 않는다)', () => {
    const dir = tmpDir();
    expect(readBootProgress(dir)).toBeNull();
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(bootProgressPath(dir), '{ not json');
    expect(readBootProgress(dir)).toBeNull();
    fs.writeFileSync(bootProgressPath(dir), JSON.stringify({ stage: 'nope', at: 1, startedAt: 1 }));
    expect(readBootProgress(dir)).toBeNull();
  });

  it('markBootStage는 프로세스 시작 시각(startedAt)을 uptime에서 역산해 넣는다', () => {
    const dir = tmpDir();
    const now = 1_700_000_000_000;
    markBootStage(dir, 'rag', undefined, now);
    const p = readBootProgress(dir)!;
    expect(p.stage).toBe('rag');
    expect(p.at).toBe(now);
    expect(p.pid).toBe(process.pid);
    expect(p.startedAt).toBeLessThanOrEqual(now);
    expect(now - p.startedAt).toBeCloseTo(process.uptime() * 1000, -3);
  });

  it('쓰기 실패는 삼킨다(계측이 부팅을 못 막게)', () => {
    // 파일이 놓일 자리를 파일로 막아 mkdir/write를 실패시킨다.
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'state'), 'not a dir');
    expect(() => markBootStage(dir, 'wiki')).not.toThrow();
  });
});

describe('스플래시 표시 문구', () => {
  const CHILD = 1_000_000; // 이전 실행 기록(startedAt≈0)과 확실히 갈리는 값

  it('단계를 아직 못 받았으면 기존 문구 + 경과 시간만 보여준다', () => {
    expect(bootSplashText(null, CHILD, CHILD + 5000, true)).toBe('Engram 시작 중… · 5초');
    expect(bootSplashText(null, CHILD, CHILD + 5000, false)).toBe('Starting Engram… · 5s');
  });

  it('단계·진행률·경과 시간을 한 줄로 만든다', () => {
    const p = { stage: 'index' as const, at: CHILD + 3000, startedAt: CHILD, pid: 1, done: 4, total: 12 };
    expect(bootSplashText(p, CHILD, CHILD + 80_000, true)).toBe('위키 페이지 색인 중 4/12 (4/5) · 1분 20초');
    expect(bootSplashText(p, CHILD, CHILD + 80_000, false)).toBe('Indexing wiki pages 4/12 (4/5) · 1m 20s');
  });

  it('total이 없으면 건수 없이 단계만(0건 위키 등)', () => {
    const p = { stage: 'rag' as const, at: CHILD, startedAt: CHILD, pid: 1 };
    expect(bootSplashText(p, CHILD, CHILD + 2000, true)).toBe('검색 색인 여는 중 (3/5) · 2초');
  });

  it('이전 실행이 남긴 파일은 무시한다(startedAt이 이번 자식보다 앞섬)', () => {
    const old = { stage: 'ready' as const, at: 1, startedAt: 1, pid: 1 };
    expect(isFreshBootProgress(old, CHILD)).toBe(false);
    expect(bootSplashText(old, CHILD, CHILD + 1000, true)).toBe('Engram 시작 중… · 1초');
  });

  it('단계 번호는 순서대로, ready도 마지막 칸을 넘지 않는다', () => {
    expect(bootStageStep('start')).toBe(1);
    expect(bootStageStep('wiring')).toBe(BOOT_STEPS);
    expect(bootStageStep('ready')).toBe(BOOT_STEPS);
  });

  it('경과 시간은 분·초로', () => {
    expect(formatElapsed(999, true)).toBe('0초');
    expect(formatElapsed(61_000, true)).toBe('1분 1초');
    expect(formatElapsed(61_000, false)).toBe('1m 1s');
  });
});

describe('정체(stall) 판정', () => {
  const CHILD = 1_000_000; // 이전 실행 기록(startedAt≈0)과 확실히 갈리는 값
  const LIMIT = 300_000;

  it('단계가 전혀 안 오면 자식 시작 시각부터 잰다', () => {
    expect(isBootStalled(null, CHILD, CHILD + LIMIT - 1, LIMIT)).toBe(false);
    expect(isBootStalled(null, CHILD, CHILD + LIMIT, LIMIT)).toBe(true);
  });

  it('단계가 갱신되면 그때부터 다시 잰다(느리지만 진행 중 = 정체 아님)', () => {
    const p = { stage: 'index' as const, at: CHILD + 200_000, startedAt: CHILD, pid: 1 };
    expect(isBootStalled(p, CHILD, CHILD + 400_000, LIMIT)).toBe(false);
    expect(isBootStalled(p, CHILD, CHILD + 500_000, LIMIT)).toBe(true);
  });

  it('구세대 파일은 진행으로 쳐주지 않는다', () => {
    const old = { stage: 'index' as const, at: 1, startedAt: 1, pid: 1 };
    expect(isBootStalled(old, CHILD, CHILD + LIMIT, LIMIT)).toBe(true);
  });
});
