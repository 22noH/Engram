import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatStore } from '../edge/messenger/chat-store';
import { CompactService, CompactApplier, CompactProposals, CompactWiki, buildCompactSummaryPrompt, COMPACT_SUMMARY_DEFAULT } from './compact';
import type { BrainProvider, BrainResult } from '../brain/brain.port';
import type { NewProposal, Proposal } from '../knowledge-core/proposal-store';

// 3인칭이 아니라 요약 자체에는 절대 등장하지 않을 고유 마커 — 원문 유출 여부 판정용.
const SECRET_1 = 'RAW_USER_TEXT_alpha_9f3';
const SECRET_2 = 'RAW_USER_TEXT_beta_2k7';
const SECRET_3 = 'RAW_USER_TEXT_gamma_5m1';
const FIXED_SUMMARY = 'Test Summary Title\n\n- key point one\n- key point two';
const EXPECTED_SLUG = 'test-summary-title';

function makeBrain(result: Partial<BrainResult> = {}): BrainProvider {
  const complete = jest.fn(async (): Promise<BrainResult> => ({
    text: FIXED_SUMMARY,
    costUsd: 0,
    isError: false,
    ...result,
  }));
  return { complete } as unknown as BrainProvider;
}

function makeProposal(input: NewProposal): Proposal {
  return { ...input, id: 'test-proposal-id', createdTs: '2026-07-22T00:00:00.000Z', status: 'pending' };
}

describe('buildCompactSummaryPrompt', () => {
  it('instruction + transcript를 담고, source 출력 지시를 붙인다', () => {
    const p = buildCompactSummaryPrompt(COMPACT_SUMMARY_DEFAULT, { transcript: 'alice: hi\nbob: hello' });
    expect(p).toContain(COMPACT_SUMMARY_DEFAULT);
    expect(p).toContain('alice: hi\nbob: hello');
    expect(p).toContain('same language as the source text');
  });
});

describe('CompactService', () => {
  let dir: string;
  let chat: ChatStore;
  let wiki: jest.Mocked<CompactWiki>;
  let proposals: jest.Mocked<CompactProposals>;
  let applier: jest.Mocked<CompactApplier>;
  let service: CompactService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-compact-'));
    chat = new ChatStore(dir);
    chat.listChannels(); // general 채널 생성
    wiki = { getPage: jest.fn().mockResolvedValue(null) };
    proposals = { enqueue: jest.fn(async (p: NewProposal) => makeProposal(p)) };
    applier = { apply: jest.fn().mockResolvedValue(undefined) };
    service = new CompactService(chat, wiki, proposals, applier);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function seedThreeMessages(): void {
    chat.appendMessage('general', { authorId: 'u1', authorName: 'Alice', text: SECRET_1 });
    chat.appendMessage('general', { authorId: 'u2', authorName: 'Bob', text: SECRET_2 });
    chat.appendMessage('general', { authorId: 'u1', authorName: 'Alice', text: SECRET_3 });
  }

  it('3줄 채널 compact: enqueue(create, compact-summary, payload=요약)·apply 호출·history가 앵커 1줄로 정리·반환값', async () => {
    seedThreeMessages();
    const brain = makeBrain();

    const result = await service.compact('general', { brain });

    expect(result).toEqual({ summary: FIXED_SUMMARY, slug: EXPECTED_SLUG });

    expect(proposals.enqueue).toHaveBeenCalledTimes(1);
    const enqueued = proposals.enqueue.mock.calls[0][0];
    expect(enqueued.op).toBe('create');
    expect(enqueued.category).toBe('compact-summary');
    expect(enqueued.payload).toBe(FIXED_SUMMARY);
    expect(enqueued.targetSlug).toBe(EXPECTED_SLUG);
    expect(enqueued.userId).toBe('default');

    expect(applier.apply).toHaveBeenCalledTimes(1);
    expect(applier.apply.mock.calls[0][0]).toMatchObject({ payload: FIXED_SUMMARY, op: 'create' });

    const history = chat.history('general');
    expect(history).toHaveLength(1);
    expect(history[0].authorId).toBe('engram');
    expect(history[0].authorName).toBe('Engram');
    expect(history[0].text).toContain(EXPECTED_SLUG);
    expect(history[0].text).toContain(FIXED_SUMMARY);
  });

  it('기존 위키 페이지가 있으면(dedup) op=append', async () => {
    seedThreeMessages();
    wiki.getPage.mockResolvedValueOnce({ slug: EXPECTED_SLUG } as never);
    const brain = makeBrain();

    await service.compact('general', { brain });

    expect(proposals.enqueue.mock.calls[0][0].op).toBe('append');
  });

  it('auto:true면 category=auto-compact', async () => {
    seedThreeMessages();
    const brain = makeBrain();

    await service.compact('general', { brain, auto: true });

    expect(proposals.enqueue.mock.calls[0][0].category).toBe('auto-compact');
  });

  it('브레인 isError면 null 반환하고 정리하지 않는다(history 그대로)', async () => {
    seedThreeMessages();
    const brain = makeBrain({ isError: true, text: '' });

    const result = await service.compact('general', { brain });

    expect(result).toBeNull();
    expect(proposals.enqueue).not.toHaveBeenCalled();
    const history = chat.history('general');
    expect(history).toHaveLength(3);
    expect(history.map((m) => m.text)).toEqual([SECRET_1, SECRET_2, SECRET_3]);
  });

  it('요약 텍스트가 공백뿐이면 null 반환하고 정리하지 않는다', async () => {
    seedThreeMessages();
    const brain = makeBrain({ text: '   \n  ', isError: false });

    const result = await service.compact('general', { brain });

    expect(result).toBeNull();
    expect(chat.history('general')).toHaveLength(3);
  });

  it('위키 저장(enqueue/apply)이 실패하면 null 반환하고 정리하지 않는다(지식 유실 방지)', async () => {
    seedThreeMessages();
    applier.apply.mockRejectedValueOnce(new Error('disk full'));
    const brain = makeBrain();

    const result = await service.compact('general', { brain });

    expect(result).toBeNull();
    const history = chat.history('general');
    expect(history).toHaveLength(3); // clearChannel이 호출되지 않았어야 함
    expect(history.map((m) => m.text)).toEqual([SECRET_1, SECRET_2, SECRET_3]);
  });

  it('빈 채널은 null(브레인 호출조차 안 함)', async () => {
    const brain = makeBrain();

    const result = await service.compact('general', { brain });

    expect(result).toBeNull();
    expect((brain.complete as jest.Mock)).not.toHaveBeenCalled();
    expect(proposals.enqueue).not.toHaveBeenCalled();
  });

  it('위키 payload에는 요약만 담기고 대화 원문 마커는 절대 포함되지 않는다', async () => {
    seedThreeMessages();
    const brain = makeBrain();

    await service.compact('general', { brain });

    const payload = proposals.enqueue.mock.calls[0][0].payload;
    expect(payload).not.toContain(SECRET_1);
    expect(payload).not.toContain(SECRET_2);
    expect(payload).not.toContain(SECRET_3);
    expect(payload).toBe(FIXED_SUMMARY);
  });
});
