import { IngesterAgent, parseJsonBlock } from './ingester-agent';
import { FakeBrain } from '../brain/fake-brain';
import { ImportanceGate } from '../knowledge-core/importance-gate';

const noopLogger = { error: () => {} } as any;

describe('parseJsonBlock', () => {
  it('코드펜스 안 JSON을 뽑는다', () => {
    expect(parseJsonBlock('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  });
  it('잡텍스트 사이 JSON 배열을 뽑는다', () => {
    expect(parseJsonBlock('여기 있음: [{"a":1}] 끝')).toEqual([{ a: 1 }]);
  });
  it('JSON 없으면 null', () => { expect(parseJsonBlock('그냥 텍스트')).toBeNull(); });
});

describe('IngesterAgent.extractFacts', () => {
  const facts = [
    { claim: '중요한 사실', importance: 4, sourceQuote: '대화 인용' },
    { claim: '사소', importance: 1, sourceQuote: 'q' },
    { claim: '출처없음', importance: 5, sourceQuote: '' },
  ];
  it('writer 출력을 파싱하고 출처없는 항목을 버린다', async () => {
    const writer = new FakeBrain({ text: JSON.stringify(facts), costUsd: 0, isError: false });
    const agent = new IngesterAgent({} as any, new ImportanceGate({} as any), writer, {} as any, {} as any, {} as any, noopLogger);
    const out = await agent.extractFacts('대화');
    expect(out.map((f) => f.claim)).toEqual(['중요한 사실', '사소']); // 출처없음 제거, 중요도 필터는 run에서
  });
  it('파싱 실패 시 빈 배열 + 경고', async () => {
    const writer = new FakeBrain({ text: '망가진 출력', costUsd: 0, isError: false });
    const agent = new IngesterAgent({} as any, new ImportanceGate({} as any), writer, {} as any, {} as any, {} as any, noopLogger);
    expect(await agent.extractFacts('대화')).toEqual([]);
  });
});
