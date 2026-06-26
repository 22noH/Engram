import { ReaderAgent } from './reader-agent';
import { FakeBrain } from '../brain/fake-brain';
import { SearchResult } from '../knowledge-core/rag/rag.types';

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
