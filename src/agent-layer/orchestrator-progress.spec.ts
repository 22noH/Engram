import { Orchestrator } from './orchestrator';
import type { ProgressRun } from '../../shared/protocol';

// 진행 중 표시(progress) — 다단계 작업(협업·코딩 루프)이 올리는 "중간 보고" 메시지에만 서버가
// additive 필드를 스탬프한다. 렌더러는 이 필드로만 진행 메시지를 식별한다(텍스트 패턴 매칭 금지 —
// i18n에서 깨지고 오탐한다). PostFn 5번째 인자(progress)가 그 통로다.
const logger = { warn() {}, error() {}, log() {}, info() {} } as any;

// 진행 카드(2026-07-25)부터 progress는 boolean 또는 ProgressRun 객체다 — 이 스펙은 "표식이 붙는가"만
// 보므로 객체가 와도 truthy 판정이 그대로 유효하다(카드 묶기 자체는 orchestrator-progress-card.spec).
type Posted = { text: string; progress?: boolean | ProgressRun };
function collect(posts: Posted[]) {
  return async (text: string, _a?: unknown, _q?: unknown, _t?: unknown, progress?: boolean | ProgressRun): Promise<void> => {
    posts.push({ text, progress });
  };
}

const project = {
  id: 'p', targetPath: 'C:/proj', branch: 'engram/x', writePaths: ['C:/proj'],
  gate: { test: 't', build: 'b', typecheck: 'tc' }, acceptanceCriteria: ['c1'],
  concurrency: 1, budget: { tokens: null }, approved: true,
};
function fakeBrain(text: string) { return { complete: () => Promise.resolve({ text, costUsd: 0, isError: false }) }; }

describe('진행 보고 표시(progress 필드)', () => {
  it('협업: 진행 보고만 progress=true — 팀 구성 ack·최종 결과는 아니다', async () => {
    const brain = fakeBrain('{"kind":"chat","team":[]}') as any;
    const conversations = { append: async () => {} } as any;
    const o = new Orchestrator(
      null as any, conversations, logger, null as any,
      null as any, null as any, null as any, null as any,
      null as any, null as any, null as any, null as any, null as any,
      brain, null as any, null as any, null as any,
    );
    (o as any).collaborate = async (_q: string, _team: string[], _u: string, opts: any) => {
      await opts.onProgress('✔ Brand 의견 도착');
      return '최종 결과';
    };
    const posts: Posted[] = [];
    await o.handleMention({ text: 'team Brand 전략?', userId: 'c1' }, collect(posts));
    await (o as any).drainForTest();

    expect(posts[0].progress).toBeFalsy();                                       // 팀 구성 ack = 일반 메시지
    expect(posts.find((p) => p.text === '✔ Brand 의견 도착')?.progress).toBeTruthy(); // 진행 표식(카드 이후엔 실행 표식 객체)
    expect(posts.find((p) => p.text === '최종 결과')?.progress).toBeFalsy();      // 답이 오면 진행 표시 없음
  });

  it('코딩: 시작 안내와 루프 진행 보고는 progress=true, 최종 결과는 아니다', async () => {
    const o = new Orchestrator(
      null as any, { append: async () => {} } as any, logger, null as any,
    );
    (o as any).codeRun = async (_id: string, opts: any) => {
      opts.onProgress('Breakdown complete — 2 task(s)');
      return { status: 'SUCCESS', sessionId: 's1' };
    };
    const posts: Posted[] = [];
    (o as any).launchCoding('p1', 'C:/proj', 'c1', collect(posts));
    await (o as any).drainForTest();

    expect(posts.length).toBe(3);
    expect(posts[0].progress).toBeTruthy();                     // 코딩 시작 안내
    expect(posts[1].text).toBe('· Breakdown complete — 2 task(s)');
    expect(posts[1].progress).toBeTruthy();
    expect(posts[2].progress).toBeFalsy();                      // 완료 메시지 = 일반 메시지(애니메이션 정지)
  });
});

describe('코딩 티켓 실패·재시도 노출', () => {
  function harness(work: () => Promise<string>) {
    const tickets = [{ id: 'tk0', area: 'backend', instruction: 'i', status: 'PENDING', attempts: 0, gate: null }];
    const tasks = {
      createCoding: async () => ({ id: 's1' }), transition: async () => {}, addTickets: async () => {},
      recordProgress: async () => {}, contribute: async () => {},
      updateTicket: async (_i: string, id: string, patch: any) => { const t = tickets.find((x) => x.id === id)!; Object.assign(t, patch); },
      get: async () => ({ id: 's1', tickets, blackboard: {}, progress: { landed: 0, criteriaMet: 0, criteriaTotal: 1 } }),
      setResult: async () => {}, remove: async () => {},
    };
    return new Orchestrator({} as any, {} as any, logger, {} as any,
      tasks as any, undefined, undefined, { run: (f: any) => f() } as any,
      { get: async () => project } as any,
      { run: async () => ({ pass: true, failed: null, output: '' }) } as any,
      { ensureBranch: async () => {}, commitAll: async () => {}, hasChanges: async () => true, head: async () => 'sha0', diffStat: async () => [] } as any,
      { work } as any,
      { review: async () => ({ approved: false, extraTickets: [] }) } as any,
      fakeBrain('{"tickets":[{"area":"backend","instruction":"i"}]}') as any,
      { assertWritable: () => {}, codingFlags: () => [] } as any);
  }

  it('티켓이 예외로 실패하면 재시도 안내를 진행 보고로 게시한다(로그만 남기지 않는다)', async () => {
    const o = harness(async () => { throw new Error('brain quota exhausted'); });
    const progress: string[] = [];
    await o.codeRun('p', { maxRounds: 2, stuckK: 2, onProgress: (m) => progress.push(m) });
    const retry = progress.find((m) => m.includes('brain quota exhausted'));
    expect(retry).toBeDefined();          // 실패 사유가 화면에 보인다
    expect(retry).toContain('backend');   // 어느 작업이 실패했는지도
  });

  it('실패가 없으면 재시도 안내는 안 나온다(회귀 0)', async () => {
    const o = harness(async () => '코딩함');
    const progress: string[] = [];
    await o.codeRun('p', { maxRounds: 1, stuckK: 2, onProgress: (m) => progress.push(m) });
    expect(progress.some((m) => m.includes('retry') || m.includes('다시 시도'))).toBe(false);
  });
});
