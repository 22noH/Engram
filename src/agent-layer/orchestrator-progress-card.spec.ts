import { Orchestrator } from './orchestrator';
import type { ProgressRun } from '../../shared/protocol';

// 진행 카드 + 완료 보고서(2026-07-25) — 서버 쪽 계약.
//  · 진행 보고는 "어느 실행(run)의 몇 번째 단계인지"를 표식으로 실어보낸다. 렌더러는 이 표식만으로
//    카드를 묶고, 표식이 기록(jsonl)에 남아 재시작 후에도 같은 묶음이 복원된다.
//  · 실행이 다르면 id가 달라 절대 한 카드로 섞이지 않는다(같은 채널에서 동시에 돌아도).
//  · 코딩이 끝나면 두뇌가 실제 재료를 보고 완료 보고서를 쓴다. 못 쓰면 기존 한 줄로 폴백 —
//    어떤 경우에도 화면이 침묵하지 않는다.

const logger = { warn() {}, error() {}, log() {}, info() {} } as any;

type Posted = { text: string; progress?: boolean | ProgressRun; report?: boolean };
function collect(posts: Posted[]) {
  return async (
    text: string, _a?: unknown, _q?: unknown, _t?: unknown,
    progress?: boolean | ProgressRun, completionReport?: boolean,
  ): Promise<void> => { posts.push({ text, progress, report: completionReport }); };
}

const project = {
  id: 'p', targetPath: 'C:/proj', branch: 'engram/x', writePaths: ['C:/proj'],
  gate: { test: 'npm test', build: 'npm run build', typecheck: 'tsc --noEmit' },
  acceptanceCriteria: ['c1'], concurrency: 1, budget: { tokens: null }, approved: true,
};
const emptyLog = { baseSha: 'sha0', landed: [], retries: [], rounds: 1 };

function runsOf(posts: Posted[]): ProgressRun[] {
  return posts.map((p) => p.progress).filter((p): p is ProgressRun => typeof p === 'object' && p !== null);
}

describe('진행 카드 표식(실행 묶기)', () => {
  function orch(): Orchestrator {
    return new Orchestrator(null as any, { append: async () => {} } as any, logger, null as any);
  }

  it('한 실행의 모든 진행 보고가 같은 실행 id와 제목을 단다(카드 하나로 묶이는 근거)', async () => {
    const o = orch();
    (o as any).codeRun = async (_id: string, opts: any) => {
      opts.onProgress('분해 완료');
      opts.onProgress('착지');
      return { status: 'SUCCESS', sessionId: 's1', log: emptyLog };
    };
    const posts: Posted[] = [];
    (o as any).launchCoding('p1', 'C:/proj', 'c1', collect(posts));
    await (o as any).drainForTest();

    const runs = runsOf(posts);
    expect(runs.length).toBe(3); // 시작 안내 + 단계 2개
    expect(new Set(runs.map((r) => r.id)).size).toBe(1);
    expect(runs[0].title).toBeTruthy(); // 카드 제목(작업명)
    // 최종 메시지엔 표식이 없다 — 렌더러가 그 순간 카드를 "완료"로 접는다.
    expect(posts[posts.length - 1].progress).toBeFalsy();
  });

  it('다른 실행끼리는 실행 id가 달라 한 카드로 안 섞인다', async () => {
    const o = orch();
    (o as any).codeRun = async (_id: string, opts: any) => {
      opts.onProgress('단계');
      return { status: 'SUCCESS', sessionId: 's1', log: emptyLog };
    };
    const posts: Posted[] = [];
    (o as any).launchCoding('p1', 'C:/proj', 'c1', collect(posts));
    await (o as any).drainForTest();
    const first = runsOf(posts).map((r) => r.id);

    const posts2: Posted[] = [];
    (o as any).launchCoding('p1', 'C:/proj', 'c1', collect(posts2));
    await (o as any).drainForTest();
    const second = runsOf(posts2).map((r) => r.id);

    expect(new Set(first).size).toBe(1);
    expect(new Set(second).size).toBe(1);
    expect(first[0]).not.toBe(second[0]);
  });

  it('재시도 단계는 kind=retry로 표시된다(렌더러가 텍스트를 뜯어보지 않게)', async () => {
    const tickets = [{ id: 'tk0', area: 'backend', instruction: 'i', status: 'PENDING', attempts: 0, gate: null }];
    const tasks = {
      createCoding: async () => ({ id: 's1' }), transition: async () => {}, addTickets: async () => {},
      recordProgress: async () => {}, contribute: async () => {},
      updateTicket: async (_i: string, id: string, patch: any) => { Object.assign(tickets.find((x) => x.id === id)!, patch); },
      get: async () => ({ id: 's1', tickets, blackboard: {}, progress: { landed: 0, criteriaMet: 0, criteriaTotal: 1 } }),
      setResult: async () => {}, remove: async () => {},
    };
    const o = new Orchestrator({} as any, {} as any, logger, {} as any,
      tasks as any, undefined, undefined, { run: (f: any) => f() } as any,
      { get: async () => project } as any,
      { run: async () => ({ pass: true, failed: null, output: '' }) } as any,
      { ensureBranch: async () => {}, commitAll: async () => {}, head: async () => 'sha0', diffStat: async () => [] } as any,
      { work: async () => { throw new Error('사용량 한도'); } } as any,
      { review: async () => ({ approved: false, extraTickets: [] }) } as any,
      { complete: async () => ({ text: '{"tickets":[{"area":"backend","instruction":"i"}]}', costUsd: 0, isError: false }) } as any,
      { assertWritable: () => {}, codingFlags: () => [] } as any);

    const steps: Array<{ m: string; kind?: string }> = [];
    await o.codeRun('p', { maxRounds: 1, stuckK: 2, onProgress: (m, kind) => steps.push({ m, kind }) });
    expect(steps.some((s) => s.kind === 'retry' && s.m.includes('backend'))).toBe(true);
    // 보통 단계엔 kind가 없다(회귀 0 — 마커는 기본이 진행/완료).
    expect(steps.some((s) => s.kind === undefined)).toBe(true);
  });
});

describe('완료 보고서', () => {
  function orch(brainText: string | null, opts: { projects?: boolean } = {}): Orchestrator {
    const brain = {
      complete: async () => (brainText === null
        ? { text: '', costUsd: 0, isError: true }
        : { text: brainText, costUsd: 0, isError: false }),
    };
    return new Orchestrator(null as any, { append: async () => {} } as any, logger, null as any,
      null as any, null as any, null as any, null as any,
      opts.projects === false ? (null as any) : ({ get: async () => project } as any),
      null as any,
      { head: async () => 'sha0', diffStat: async () => [{ path: 'src/a.ts', added: 10, removed: 2 }] } as any,
      null as any, null as any, brain as any, null as any, null as any, null as any);
  }

  async function runCoding(o: Orchestrator, posts: Posted[]): Promise<void> {
    (o as any).codeRun = async () => ({
      status: 'SUCCESS', sessionId: 's1',
      log: { baseSha: 'sha0', landed: [{ area: 'backend', summary: '했음' }], retries: [], rounds: 2 },
    });
    (o as any).launchCoding('p1', 'C:/proj', 'c1', collect(posts));
    await (o as any).drainForTest();
  }

  it('성공하면 두뇌가 쓴 보고서를 표식과 함께 올리고 기존 한 줄은 대체한다', async () => {
    const posts: Posted[] = [];
    await runCoding(orch('# 보고서\n**남은 것 · 판단 필요**\n- 없음'), posts);
    const report = posts.find((p) => p.report === true);
    expect(report).toBeDefined();
    expect(report!.text).toContain('보고서');
    expect(posts.some((p) => p.text.includes('코딩 완료') || p.text.includes('Coding complete'))).toBe(false);
  });

  it('보고서 재료엔 실제 결과(착지·변경 파일·게이트 명령)가 들어간다 — 템플릿 채우기가 아니다', async () => {
    let seen = '';
    const o = orch('보고서');
    (o as any).codeBrain = { complete: async (p: string) => { seen = p; return { text: '보고서', costUsd: 0, isError: false }; } };
    const text = await o.buildCompletionReport('p1', {
      baseSha: 'sha0', landed: [{ area: 'backend', summary: '리뷰 붙임' }],
      retries: [{ area: 'ui', attempt: 2, reason: '사용량 한도' }], rounds: 3,
    });
    expect(text).toBe('보고서');
    expect(seen).toContain('리뷰 붙임');
    expect(seen).toContain('사용량 한도');
    expect(seen).toContain('src/a.ts');
    expect(seen).toContain('npm test');
  });

  it('두뇌가 실패하면 기존 ✓ 코딩 완료 한 줄로 폴백한다(절대 침묵 금지)', async () => {
    const posts: Posted[] = [];
    await runCoding(orch(null), posts);
    expect(posts.some((p) => p.report === true)).toBe(false);
    expect(posts.some((p) => /코딩 완료|Coding complete/.test(p.text))).toBe(true);
  });

  it('빈 응답도 폴백이다(빈 메시지를 올리지 않는다)', async () => {
    const posts: Posted[] = [];
    await runCoding(orch('   '), posts);
    expect(posts.some((p) => p.report === true)).toBe(false);
    expect(posts.some((p) => /코딩 완료|Coding complete/.test(p.text))).toBe(true);
  });

  it('프로젝트를 못 찾아도 폴백한다(보고서 실패가 완료 사실을 삼키지 않는다)', async () => {
    const posts: Posted[] = [];
    await runCoding(orch('보고서', { projects: false }), posts);
    expect(posts.some((p) => p.report === true)).toBe(false);
    expect(posts.some((p) => /코딩 완료|Coding complete/.test(p.text))).toBe(true);
  });
});
