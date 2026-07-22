import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatStore, ChatMessage } from '../edge/messenger/chat-store';
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

  it('500개 초과 채널도 전체를 요약한다(clear는 채널 전체를 지우므로 요약 범위=삭제 범위 일치·리뷰 지적)', async () => {
    // 가장 오래된 메시지에 고유 마커 — 500 상한이 있으면 이건 요약 프롬프트에 안 담긴다.
    const OLDEST = 'OLDEST_MSG_marker_zzz';
    chat.appendMessage('general', { authorId: 'u1', authorName: 'Alice', text: OLDEST });
    for (let i = 0; i < 600; i++) chat.appendMessage('general', { authorId: 'u1', text: `m${i}` });
    const brain = makeBrain();

    const result = await service.compact('general', { brain });

    // 브레인에 넘긴 프롬프트가 가장 오래된 메시지까지 포함해야 함(전체 601개 읽음).
    const prompt = (brain.complete as jest.Mock).mock.calls[0][0] as string;
    expect(prompt).toContain(OLDEST);
    // compact 후 채널 전체가 정리되고 앵커 1줄만 남음 — 요약 안 된 잔여 없음.
    expect(result).not.toBeNull();
    expect(chat.history('general', { limit: Number.MAX_SAFE_INTEGER })).toHaveLength(1);
  });

  it('앵커 append가 던져도(디스크풀/잠금) compact는 throw하지 않고 결과를 반환한다(never-throw·리뷰 지적)', async () => {
    seedThreeMessages();
    const brain = makeBrain();
    // 위키 저장은 성공, 그 다음 앵커 append만 실패하도록. clearChannel은 이미 실행된 뒤.
    const appendSpy = jest.spyOn(chat, 'appendMessage').mockImplementation(() => { throw new Error('EBUSY'); });
    try {
      const result = await service.compact('general', { brain });
      expect(result).toEqual({ summary: FIXED_SUMMARY, slug: EXPECTED_SLUG }); // throw 아님·결과 반환
    } finally {
      appendSpy.mockRestore();
    }
    // 위키 저장은 성공했어야 함(앵커 실패와 무관).
    expect(applier.apply).toHaveBeenCalledTimes(1);
  });
});

// Task 5(clear-compact): 자동 compact가 쓰는 summarizeToWiki — "주어진 메시지 목록만" 요약→위키 게시하고,
// compact()와 달리 채널 히스토리는 절대 건드리지 않는다(호출부=chat-store가 별도로 정밀 제거한다).
describe('CompactService.summarizeToWiki', () => {
  let dir: string;
  let chat: ChatStore;
  let wiki: jest.Mocked<CompactWiki>;
  let proposals: jest.Mocked<CompactProposals>;
  let applier: jest.Mocked<CompactApplier>;
  let service: CompactService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-compact-summarize-'));
    chat = new ChatStore(dir);
    chat.listChannels(); // general 채널 생성
    wiki = { getPage: jest.fn().mockResolvedValue(null) };
    proposals = { enqueue: jest.fn(async (p: NewProposal) => makeProposal(p)) };
    applier = { apply: jest.fn().mockResolvedValue(undefined) };
    service = new CompactService(chat, wiki, proposals, applier);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function msg(id: string, text: string, authorId = 'u1', authorName?: string): ChatMessage {
    return { id, authorId, text, ts: '2026-07-22T00:00:00.000Z', ...(authorName ? { authorName } : {}) };
  }

  it('enqueue(auto-compact 카테고리)+apply 호출, {slug} 반환', async () => {
    const brain = makeBrain();
    const dropped = [msg('m1', SECRET_1, 'u1', 'Alice'), msg('m2', SECRET_2, 'u2', 'Bob')];

    const result = await service.summarizeToWiki('general', dropped, { brain, auto: true });

    expect(result).toEqual({ slug: EXPECTED_SLUG });
    expect(proposals.enqueue).toHaveBeenCalledTimes(1);
    const enqueued = proposals.enqueue.mock.calls[0][0];
    expect(enqueued.category).toBe('auto-compact');
    expect(enqueued.op).toBe('create');
    expect(enqueued.payload).toBe(FIXED_SUMMARY); // 요약만 — 원문 아님
    expect(applier.apply).toHaveBeenCalledTimes(1);
  });

  it('채널 히스토리를 전혀 건드리지 않는다(clearChannel 미호출) — 실제 채널 메시지와 무관한 목록을 넘겨도 그대로', async () => {
    chat.appendMessage('general', { authorId: 'owner', text: 'stays-1' });
    chat.appendMessage('general', { authorId: 'owner', text: 'stays-2' });
    chat.appendMessage('general', { authorId: 'owner', text: 'stays-3' });
    const brain = makeBrain();
    const dropped = [msg('other-1', SECRET_1)]; // 채널에 실재하지 않는 임의 메시지 — history()를 안 읽는다는 증거

    const result = await service.summarizeToWiki('general', dropped, { brain });

    expect(result).toEqual({ slug: EXPECTED_SLUG });
    // 브레인에 넘긴 프롬프트는 dropped(SECRET_1)만 담고, 실채널 메시지(stays-*)는 안 담김.
    const prompt = (brain.complete as jest.Mock).mock.calls[0][0] as string;
    expect(prompt).toContain(SECRET_1);
    expect(prompt).not.toContain('stays-1');
    // 채널 히스토리는 3개 그대로(정리는 호출부 책임 — 이 메서드는 절대 지우지 않음).
    expect(chat.history('general').map((m) => m.text)).toEqual(['stays-1', 'stays-2', 'stays-3']);
  });

  it('빈 msgs → null(브레인 호출 안 함)', async () => {
    const brain = makeBrain();

    const result = await service.summarizeToWiki('general', [], { brain });

    expect(result).toBeNull();
    expect((brain.complete as jest.Mock)).not.toHaveBeenCalled();
    expect(proposals.enqueue).not.toHaveBeenCalled();
  });

  it('브레인 에러 → null, 위키 저장 시도 안 함', async () => {
    const brain = makeBrain({ isError: true, text: '' });
    const dropped = [msg('m1', SECRET_1)];

    const result = await service.summarizeToWiki('general', dropped, { brain });

    expect(result).toBeNull();
    expect(proposals.enqueue).not.toHaveBeenCalled();
  });

  it('위키 저장 실패 → null', async () => {
    applier.apply.mockRejectedValueOnce(new Error('disk full'));
    const brain = makeBrain();
    const dropped = [msg('m1', SECRET_1)];

    const result = await service.summarizeToWiki('general', dropped, { brain });

    expect(result).toBeNull();
  });

  it('auto 미지정(수동 경로 재사용 시)이면 category=compact-summary', async () => {
    const brain = makeBrain();
    const dropped = [msg('m1', SECRET_1)];

    await service.summarizeToWiki('general', dropped, { brain });

    expect(proposals.enqueue.mock.calls[0][0].category).toBe('compact-summary');
  });
});
