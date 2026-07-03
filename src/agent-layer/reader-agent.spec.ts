import { ReaderAgent } from './reader-agent';
import { FakeBrain } from '../brain/fake-brain';
import { SearchResult } from '../knowledge-core/rag/rag.types';
import { InsightContext } from '../knowledge-core/insight/insight-context';
import { PathResolver } from '../pal/path-resolver';
import { PinoLogger } from '../pal/logger';
import { RagStore } from '../knowledge-core/rag/rag-store';

const ragWith = (hits: { slug: string; title: string; text: string }[]): RagStore =>
  ({ search: async () => hits } as unknown as RagStore);
const brainEcho = (capture?: (p: string) => void) => ({
  complete: async (prompt: string) => { capture?.(prompt); return { text: '답', costUsd: 0, isError: false }; },
});

// RagStore의 search만 쓰는 최소 스텁.
function stubRag(results: SearchResult[]) {
  return { search: jest.fn(async () => results) } as any;
}
const logger = { error: jest.fn() } as any;

describe('ReaderAgent', () => {
  it('검색 결과를 컨텍스트로 brain에 넘기고 답+출처를 반환한다', async () => {
    const rag = stubRag([{ slug: 'a', title: 'A페이지', text: '본문', score: 1 }]);
    const reader = new ReaderAgent(rag, new FakeBrain({ text: '답이다', costUsd: 0, isError: false }), logger);
    const out = await reader.handle({ text: '질문', userId: 'default' });
    expect(rag.search).toHaveBeenCalledWith('질문', 5, 'default');
    expect(out).toContain('답이다');
    expect(out).toContain('출처:');
    expect(out).toContain('A페이지');
    expect(out).toContain('(a)');
  });

  it('검색 결과가 없으면 경고 머리말을 붙이고 출처는 없다', async () => {
    const rag = stubRag([]);
    const reader = new ReaderAgent(rag, new FakeBrain({ text: '일반답', costUsd: 0, isError: false }), logger);
    const out = await reader.handle({ text: '질문', userId: 'default' });
    expect(out).toContain('⚠ 위키에 관련 내용 없음');
    expect(out).not.toContain('출처:');
  });

  it('brain이 isError면 실패 메시지를 반환한다', async () => {
    const rag = stubRag([{ slug: 'a', title: 'A', text: 'b', score: 1 }]);
    const reader = new ReaderAgent(rag, new FakeBrain({ text: '', costUsd: 0, isError: true }), logger);
    const out = await reader.handle({ text: '질문', userId: 'default' });
    expect(out).toContain('답변 생성 실패');
  });

  it('예외가 나도 프로세스를 죽이지 않고 실패 메시지를 반환한다', async () => {
    const rag = { search: jest.fn(async () => { throw new Error('rag down'); }) } as any;
    const reader = new ReaderAgent(rag, new FakeBrain(), logger);
    const out = await reader.handle({ text: '질문', userId: 'default' });
    expect(out).toContain('답변 생성 실패');
    expect(logger.error).toHaveBeenCalled();
  });

  it('onChunk로 머리말·본문·출처를 흘려보낸다(스트리밍)', async () => {
    const rag = stubRag([{ slug: 'a', title: 'A페이지', text: 'b', score: 1 }]);
    const reader = new ReaderAgent(rag, new FakeBrain({ text: '스트림답', costUsd: 0, isError: false }), logger);
    const chunks: string[] = [];
    const out = await reader.handle({ text: '질문', userId: 'default' }, (t) => chunks.push(t));
    const joined = chunks.join('');
    expect(joined).toContain('스트림답');
    expect(joined).toContain('출처:');
    expect(out).toBe(joined);
  });

  it('isError + onChunk일 때 반환값 == 스트리밍 청크의 합', async () => {
    const rag = stubRag([{ slug: 'a', title: 'A페이지', text: 'b', score: 1 }]);
    const reader = new ReaderAgent(rag, new FakeBrain({ text: '', costUsd: 0, isError: true }), logger);
    const chunks: string[] = [];
    const out = await reader.handle({ text: '질문', userId: 'default' }, (t) => chunks.push(t));
    const joined = chunks.join('');
    expect(out).toBe(joined);
    expect(out).toContain('답변 생성 실패');
  });
});

describe('ReaderAgent 인사이트 주입', () => {
  const insightLogger = new PinoLogger(new PathResolver(require('os').tmpdir()));

  it('onSources로 인용 slug를 노출한다', async () => {
    let slugs: string[] = [];
    const reader = new ReaderAgent(ragWith([{ slug: 's1', title: 'T', text: 'x' }]), brainEcho() as any, insightLogger);
    await reader.handle({ text: 'q', userId: 'default' }, undefined, (s) => { slugs = s; });
    expect(slugs).toEqual(['s1']);
  });

  it('InsightContext 주입 시 참고용 섹션을 프롬프트에 넣는다', async () => {
    let prompt = '';
    const ctx = { latest: async () => '(2026-06-28 기준) 도커 집중' } as unknown as InsightContext;
    const reader = new ReaderAgent(ragWith([]), brainEcho((p) => { prompt = p; }) as any, insightLogger, ctx);
    await reader.handle({ text: 'q', userId: 'default' });
    expect(prompt).toContain('참고용 사용자 맥락');
    expect(prompt).toContain('도커 집중');
  });

  it('InsightContext 없으면 참고용 섹션이 없다', async () => {
    let prompt = '';
    const reader = new ReaderAgent(ragWith([]), brainEcho((p) => { prompt = p; }) as any, insightLogger);
    await reader.handle({ text: 'q', userId: 'default' });
    expect(prompt).not.toContain('참고용 사용자 맥락');
  });
});

describe('ReaderAgent 직전 대화 주입(연속성)', () => {
  const logger2 = new PinoLogger(new PathResolver(require('os').tmpdir()));

  it('ConversationStore 주입 시 직전 대화 섹션이 프롬프트에 들어간다', async () => {
    let prompt = '';
    const convs = {
      recent: async () => [
        { ts: '2026-07-03T11:00:00Z', question: '코스피 요약해줘', answer: '웹 검색 권한이 없어 실시간 시세를 못 가져옵니다. 허용할까요?' },
      ],
    } as any;
    const reader = new ReaderAgent(ragWith([]), brainEcho((p) => { prompt = p; }) as any, logger2, undefined, convs);
    await reader.handle({ text: '1 웹검색허용', userId: 'ch-1' });
    expect(prompt).toContain('# 직전 대화');
    expect(prompt).toContain('코스피 요약해줘');
    expect(prompt).toContain('허용할까요?');
  });

  it('ConversationStore 없으면 직전 대화 섹션이 없다(기존 동작 유지)', async () => {
    let prompt = '';
    const reader = new ReaderAgent(ragWith([]), brainEcho((p) => { prompt = p; }) as any, logger2);
    await reader.handle({ text: 'q', userId: 'default' });
    expect(prompt).not.toContain('# 직전 대화');
  });

  it('recent()가 던져도 답변은 진행된다(연속성만 포기)', async () => {
    const convs = { recent: async () => { throw new Error('boom'); } } as any;
    const reader = new ReaderAgent(ragWith([]), brainEcho() as any, logger2, undefined, convs);
    const out = await reader.handle({ text: 'q', userId: 'default' });
    expect(out).not.toContain('답변 생성 실패');
  });

  it('긴 답변은 잘라서 주입한다(400자 클립)', async () => {
    let prompt = '';
    const convs = {
      recent: async () => [{ ts: '2026-07-03T11:00:00Z', question: 'q', answer: 'A'.repeat(1000) }],
    } as any;
    const reader = new ReaderAgent(ragWith([]), brainEcho((p) => { prompt = p; }) as any, logger2, undefined, convs);
    await reader.handle({ text: 'q2', userId: 'default' });
    expect(prompt).toContain('A'.repeat(400) + '…');
    expect(prompt).not.toContain('A'.repeat(401));
  });
});
