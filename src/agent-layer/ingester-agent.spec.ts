import { IngesterAgent, parseJsonBlock } from './ingester-agent';
import { FakeBrain } from '../brain/fake-brain';
import { ImportanceGate } from '../knowledge-core/importance-gate';

const noopLogger = { error: () => {}, log: () => {} } as any;
const fakeLock = { acquire: async () => true, release: async () => {} } as any;

class FakeConv {
  constructor(private recs: any[]) {}
  since = async () => this.recs;
  readCursor = async () => null;
  writeCursor = async () => {};
}
class FakeRag { search = async () => [] as any[]; }
class CaptureProposals { items: any[] = []; enqueue = async (p: any) => { this.items.push(p); return { ...p, id: 'x', status: 'pending' }; }; }

describe('parseJsonBlock', () => {
  it('코드펜스 안 JSON을 뽑는다', () => {
    expect(parseJsonBlock('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  });
  it('잡텍스트 사이 JSON 배열을 뽑는다', () => {
    expect(parseJsonBlock('여기 있음: [{"a":1}] 끝')).toEqual([{ a: 1 }]);
  });
  it('JSON 없으면 null', () => { expect(parseJsonBlock('그냥 텍스트')).toBeNull(); });
  it('꼬리 산문의 브래킷을 무시한다', () => {
    expect(parseJsonBlock('facts: [{"a":1}]. 자세한 건 [1] 참고')).toEqual([{ a: 1 }]);
  });
  it('문자열 내부 브래킷을 무시한다', () => {
    expect(parseJsonBlock('[{"q":"see ] bracket"}]')).toEqual([{ q: 'see ] bracket' }]);
  });
});

describe('IngesterAgent.extractFacts', () => {
  const facts = [
    { claim: '중요한 사실', importance: 4, sourceQuote: '대화 인용' },
    { claim: '사소', importance: 1, sourceQuote: 'q' },
    { claim: '출처없음', importance: 5, sourceQuote: '' },
  ];
  it('writer 출력을 파싱하고 출처없는 항목을 버린다', async () => {
    const writer = new FakeBrain({ text: JSON.stringify(facts), costUsd: 0, isError: false });
    const agent = new IngesterAgent({} as any, new ImportanceGate({} as any), writer, {} as any, {} as any, {} as any, noopLogger, fakeLock);
    const out = await agent.extractFacts('대화');
    expect(out.map((f) => f.claim)).toEqual(['중요한 사실', '사소']); // 출처없음 제거, 중요도 필터는 run에서
  });
  it('파싱 실패 시 빈 배열 + 경고', async () => {
    const writer = new FakeBrain({ text: '망가진 출력', costUsd: 0, isError: false });
    const agent = new IngesterAgent({} as any, new ImportanceGate({} as any), writer, {} as any, {} as any, {} as any, noopLogger, fakeLock);
    expect(await agent.extractFacts('대화')).toEqual([]);
  });
  it('writer 오류(isError) 시 빈 배열', async () => {
    const writer = new FakeBrain({ text: '', costUsd: 0, isError: true });
    const agent = new IngesterAgent({} as any, new ImportanceGate({} as any), writer, {} as any, {} as any, {} as any, noopLogger, fakeLock);
    expect(await agent.extractFacts('대화')).toEqual([]);
  });
});

describe('IngesterAgent.run', () => {
  it('추출→게이트→judge→enqueue 한 바퀴', async () => {
    const conv = new FakeConv([{ ts: '2026-06-26T01:00:00.000Z', question: 'q', answer: 'a' }]);
    const writer = new FakeBrain({ text: JSON.stringify([
      { claim: '중요', importance: 4, sourceQuote: '인용' },
      { claim: '사소', importance: 1, sourceQuote: '인용' },
    ]), costUsd: 0, isError: false });
    const judge = new FakeBrain({ text: JSON.stringify({
      verdict: 'create', targetSlug: 'jungyo', title: '중요', category: 'general', confidence: 0.9, reason: '신규',
    }), costUsd: 0, isError: false });
    const props = new CaptureProposals();
    const agent = new IngesterAgent(conv as any, new ImportanceGate({} as any), writer, judge, new FakeRag() as any, props as any, noopLogger, fakeLock);

    const stats = await agent.run('default');
    expect(stats.extracted).toBe(2);
    expect(stats.gated).toBe(1);          // '사소'(1점) 폐기
    expect(stats.proposed).toBe(1);       // '중요'만 제안
    expect(props.items[0].op).toBe('create');
    expect(props.items[0].sources).toContain('인용');
  });

  it('judge가 reject하면 제안 안 만든다', async () => {
    const conv = new FakeConv([{ ts: '2026-06-26T01:00:00.000Z', question: 'q', answer: 'a' }]);
    const writer = new FakeBrain({ text: JSON.stringify([{ claim: 'c', importance: 5, sourceQuote: 's' }]), costUsd: 0, isError: false });
    const judge = new FakeBrain({ text: JSON.stringify({ verdict: 'reject', confidence: 0.2, reason: '근거부족' }), costUsd: 0, isError: false });
    const props = new CaptureProposals();
    const agent = new IngesterAgent(conv as any, new ImportanceGate({} as any), writer, judge, new FakeRag() as any, props as any, noopLogger, fakeLock);
    const stats = await agent.run('default');
    expect(stats.proposed).toBe(0);
    expect(props.items).toHaveLength(0);
  });

  it('대화 없으면 0건이고, 빈 배치에서도 락을 해제한다', async () => {
    const release = jest.fn();
    const lock = { acquire: async () => true, release } as any;
    const agent = new IngesterAgent(new FakeConv([]) as any, new ImportanceGate({} as any), new FakeBrain() as any, new FakeBrain() as any, new FakeRag() as any, new CaptureProposals() as any, noopLogger, lock);
    expect(await agent.run('default')).toEqual({ extracted: 0, gated: 0, proposed: 0 });
    expect(release).toHaveBeenCalledWith('default'); // early-return에서도 finally가 락 해제(누수 방지)
  });

  it('배치 중 예외 시에도 커서를 전진시킨다(per-fact 격리)', async () => {
    let cursorWritten = false;
    const conv = {
      since: async () => [{ ts: '2026-06-26T01:00:00.000Z', question: 'q', answer: 'a' }],
      readCursor: async () => null,
      writeCursor: async () => { cursorWritten = true; },
    } as any;
    const writer = new FakeBrain({ text: JSON.stringify([{ claim: 'c', importance: 5, sourceQuote: 's' }]), costUsd: 0, isError: false });
    const throwingRag = { search: async () => { throw new Error('rag down'); } } as any;
    const agent = new IngesterAgent(conv, new ImportanceGate({} as any), writer, new FakeBrain() as any, throwingRag, new CaptureProposals() as any, noopLogger, fakeLock);
    const stats = await agent.run('default');
    expect(stats.proposed).toBe(0);  // 실패한 사실은 건너뜀
    expect(cursorWritten).toBe(true); // §10.3: per-fact 격리 → 커서는 정상 전진
  });

  it('첫 사실 rag 오류 시 두 번째 사실은 제안되고 커서도 전진한다(§10.3 per-fact 격리)', async () => {
    let cursorWritten = false;
    const conv = {
      since: async () => [
        { ts: '2026-06-26T01:00:00.000Z', question: 'q1', answer: 'a1' },
        { ts: '2026-06-26T02:00:00.000Z', question: 'q2', answer: 'a2' },
      ],
      readCursor: async () => null,
      writeCursor: async () => { cursorWritten = true; },
    } as any;
    const writer = new FakeBrain({ text: JSON.stringify([
      { claim: '첫사실', importance: 4, sourceQuote: '인용1' },
      { claim: '두번째사실', importance: 4, sourceQuote: '인용2' },
    ]), costUsd: 0, isError: false });
    const judge = new FakeBrain({ text: JSON.stringify({
      verdict: 'create', targetSlug: 'slug', title: '제목', category: 'general', confidence: 0.9, reason: '신규',
    }), costUsd: 0, isError: false });
    let n = 0;
    const flakyRag = { search: async () => { n++; if (n === 1) throw new Error('rag flake'); return []; } } as any;
    const props = new CaptureProposals();
    const agent = new IngesterAgent(conv, new ImportanceGate({} as any), writer, judge, flakyRag, props as any, noopLogger, fakeLock);
    const stats = await agent.run('default');
    expect(stats.proposed).toBe(1);       // 첫 사실 드롭, 두 번째 사실 제안
    expect(cursorWritten).toBe(true);     // 커서 정상 전진
    expect(props.items).toHaveLength(1);  // 두 번째 사실만 enqueue됨
  });

  it('락 획득 실패(다른 다이제스트 진행 중) 시 처리하지 않고 건너뛴다', async () => {
    const conv = new FakeConv([{ ts: '2026-06-26T01:00:00.000Z', question: 'q', answer: 'a' }]);
    const writer = new FakeBrain({ text: JSON.stringify([{ claim: 'c', importance: 5, sourceQuote: 's' }]), costUsd: 0, isError: false });
    const props = new CaptureProposals();
    const heldLock = { acquire: async () => false, release: async () => {} } as any;
    const agent = new IngesterAgent(conv as any, new ImportanceGate({} as any), writer, new FakeBrain() as any, new FakeRag() as any, props as any, noopLogger, heldLock);
    expect(await agent.run('default')).toEqual({ extracted: 0, gated: 0, proposed: 0 });
    expect(props.items).toHaveLength(0); // 락 못 잡으면 아무것도 안 함
  });
});

describe('IngesterAgent 프롬프트 영어화', () => {
  it('extractFacts prompt: english + source directive + json contract', async () => {
    let captured = '';
    const brain = { complete: async (p: string) => { captured = p; return { text: '[]', costUsd: 0 }; } };
    const ing = new IngesterAgent({} as any, {} as any, brain as any, brain as any, {} as any, {} as any, { error(){} } as any, {} as any);
    await ing.extractFacts('conv');
    expect(/[가-힣]/.test(captured)).toBe(false);
    expect(captured).toContain('Write the extracted facts in the same language as the source text.');
    expect(captured).toContain('"claim"');
  });
  it('judgeFact prompt: english + json contract', async () => {
    let captured = '';
    const judge = { complete: async (p: string) => { captured = p; return { text: '{"verdict":"reject","confidence":0,"reason":"x"}', costUsd: 0 }; } };
    const ing = new IngesterAgent({} as any, {} as any, judge as any, judge as any, {} as any, {} as any, { error(){} } as any, {} as any);
    await (ing as any).judgeFact({ claim: 'c', importance: 3, sourceQuote: 's' }, []);
    expect(/[가-힣]/.test(captured)).toBe(false);
    expect(captured).toContain('Output only a JSON object');
  });
});
