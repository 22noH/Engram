import { Orchestrator } from './orchestrator';

const logger = { warn() {}, error() {}, log() {} } as any;

// brainText: codeBrain.complete가 돌려줄 텍스트(테스트마다 주입).
function makeOrch(brainText: string) {
  const brain = { complete: async () => ({ text: brainText, costUsd: 0, isError: false }) } as any;
  const conversations = { append: async () => {}, recent: async () => [] } as any;
  const projects = {} as any;                   // truthy(escalate 가능 조건)
  const fence = { assertWritable() {} } as any; // truthy + 허용
  const registry = { all: () => [] } as any;
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    projects, null as any, null as any, null as any, null as any,
    brain, fence, null as any, registry, null as any,
  );
  return o;
}

type Posted = { text: string; actions?: any[]; question?: any };
function collect() {
  const posts: Posted[] = [];
  const post = async (text: string, actions?: any[], question?: any) => { posts.push({ text, actions, question }); };
  return { posts, post };
}

// 실사고(2026-07-25): 코드 채널만 extractAskUser 미배선이라 두뇌가 되물어도 카드가 안 뜨고,
// 펜스 JSON이 채팅에 날것으로 찍혔다. "[구현 시작] 버튼과 경합"이 이유였지만 되묻는 턴은
// 애초에 구현 제안이 아니라 경합 자체가 없다 — 질문이 이기고 버튼·pending은 안 건다.
const ASK_FENCE = '```ask_user\n{"questions":[{"q":"A와 B 중 뭘로 할까요?","options":[{"label":"A"},{"label":"B"}]}]}\n```';

it('Code 채널: 두뇌가 ask_user 블록을 내면 질문 카드로 게시(JSON 날것 노출 없음)', async () => {
  const orch = makeOrch(`정하고 가야 해요.\n${ASK_FENCE}`);
  const { posts, post } = collect();
  await orch.handleMention(
    { text: '재리뷰까지 할까?', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1',
  );
  expect(posts).toHaveLength(1);
  expect(posts[0].question).toEqual({
    questions: [{ q: 'A와 B 중 뭘로 할까요?', options: [{ label: 'A' }, { label: 'B' }] }],
  });
  expect(posts[0].text).toBe('정하고 가야 해요.');
  expect(posts[0].text).not.toContain('ask_user'); // 펜스 잔재 없음
});

it('Code 채널: 질문과 구현제안이 동시에 오면 질문이 이긴다(버튼·pending 없음)', async () => {
  const orch = makeOrch(`붙일 수 있어요.\n\`\`\`engram:propose\n{"goal":"로그인"}\n\`\`\`\n${ASK_FENCE}`);
  const { posts, post } = collect();
  await orch.handleMention(
    { text: '로그인 붙여줘', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1',
  );
  expect(posts[0].question).toBeDefined();
  expect(posts[0].actions).toBeUndefined();                  // 되묻는 턴엔 [구현 시작] 안 붙는다
  expect((orch as any).pending.get('c1')).toBeUndefined();   // 답을 받기 전엔 제안 확정 안 함
});

it('Code 채널: 적재되는 대화 기록에도 펜스 JSON이 아니라 표시 텍스트가 남는다', async () => {
  const brain = { complete: async () => ({ text: `정하고 가야 해요.\n${ASK_FENCE}`, costUsd: 0, isError: false }) } as any;
  const append = jest.fn(async () => {});
  const conversations = { append, recent: async () => [] } as any;
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    {} as any, null as any, null as any, null as any, null as any,
    brain, { assertWritable() {} } as any, null as any, { all: () => [] } as any, null as any,
  );
  const { post } = collect();
  await o.handleMention({ text: '재리뷰?', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1');
  expect(append).toHaveBeenCalledWith('c1', expect.objectContaining({ answer: '정하고 가야 해요.' }));
});

it('Code 채널 질문은 대화 답변만 — 버튼·제안 없음', async () => {
  const orch = makeOrch('여기 원인은 add.js가 없어서야.');
  const { posts, post } = collect();
  await orch.handleMention(
    { text: '왜 막혔어?', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1',
  );
  expect(posts).toHaveLength(1);
  expect(posts[0].text).toContain('원인');
  expect(posts[0].actions).toBeUndefined();
});

it('Code 채널 대화는 다음 턴 연속성을 위해 ConversationStore에 적재된다', async () => {
  const brain = { complete: async () => ({ text: '원인은 X.', costUsd: 0, isError: false }) } as any;
  const append = jest.fn(async () => {});
  const conversations = { append, recent: async () => [] } as any;
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    {} as any, null as any, null as any, null as any, null as any,
    brain, { assertWritable() {} } as any, null as any, { all: () => [] } as any, null as any,
  );
  const { post } = collect();
  await o.handleMention({ text: '왜 막혔어?', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1');
  expect(append).toHaveBeenCalledWith('c1', expect.objectContaining({ question: '왜 막혔어?', answer: '원인은 X.' }));
});

it('Code 채널 코드요청은 답변 + [구현 시작] 버튼 + pending=proposeReady', async () => {
  const orch = makeOrch('바로 붙일게.\n```engram:propose\n{"goal":"로그인 붙이기"}\n```');
  const { posts, post } = collect();
  await orch.handleMention(
    { text: '로그인 붙여줘', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1',
  );
  expect(posts).toHaveLength(1);
  expect(posts[0].text).toBe('바로 붙일게.');
  expect(posts[0].actions).toEqual([{ label: 'Start implementation', send: '구현 시작' }]);
  expect((orch as any).pending.get('c1')).toEqual({ kind: 'proposeReady', repoPath: 'C:/repo/app', goal: '로그인 붙이기' });
});

it('Code 모드인데 repoPath 없으면 폴더 안내만', async () => {
  const orch = makeOrch('무시됨');
  const { posts, post } = collect();
  await orch.handleMention({ text: '뭐든', userId: 'c1', mode: 'code' }, post, 'c1');
  expect(posts[0].text).toMatch(/폴더|folder/i);
});

it('[구현 시작] 누르면 startProposal로 escalate', async () => {
  const orch = makeOrch('바로 붙일게.\n```engram:propose\n{"goal":"로그인 붙이기"}\n```');
  const spyProposal = jest.spyOn(orch as any, 'startProposal').mockResolvedValue(undefined);
  const { post } = collect();
  // 1) 코드요청 → pending=proposeReady
  await orch.handleMention(
    { text: '로그인 붙여줘', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1',
  );
  // 2) 구현 시작 → startProposal(repoPath, goal)
  await orch.handleMention(
    { text: '구현 시작', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1',
  );
  // 5번째 인자는 요청 한정 채널 두뇌(Task 2, 스펙 §3.2) — channelBrain 미주입이면 codeBrain 그대로 전달.
  expect(spyProposal).toHaveBeenCalledWith('C:/repo/app', '로그인 붙이기', 'c1', expect.any(Function), expect.anything());
  expect((orch as any).pending.get('c1')).toBeUndefined(); // proposeReady 소비됨
});

it('Code 채널 두뇌 isError(raw=API키오류)면 실행 가능한 안내로 답한다', async () => {
  const brain = { complete: async () => ({ text: '', costUsd: 0, isError: true, raw: 'HTTP 401: invalid x-api-key' }) } as any;
  const conversations = { append: async () => {}, recent: async () => [] } as any;
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    {} as any, null as any, null as any, null as any, null as any,
    brain, { assertWritable() {} } as any, null as any, { all: () => [] } as any, null as any,
  );
  const { posts, post } = collect();
  await o.handleMention({ text: '왜 막혔어?', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1');
  expect(posts[0].text).toBe('Invalid API key — please check it in Settings.');
});

it('proposeReady 중 비매칭 메시지는 제안을 버리고 일반 대화로 흐른다', async () => {
  const orch = makeOrch('그건 이래.'); // 두 번째 턴은 마커 없는 일반 답
  const spyProposal = jest.spyOn(orch as any, 'startProposal').mockResolvedValue(undefined);
  const { posts, post } = collect();
  (orch as any).pending.set('c1', { kind: 'proposeReady', repoPath: 'C:/repo/app', goal: 'X' });
  await orch.handleMention(
    { text: '아니 그거 말고 이건 뭐야?', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1',
  );
  expect(spyProposal).not.toHaveBeenCalled();
  expect((orch as any).pending.get('c1')).toBeUndefined(); // 스테일 제안 정리
  expect(posts[posts.length - 1].text).toContain('그건 이래'); // 대화로 응답
});

// 코드 채널 스트리밍(2026-07-25): 실시간 스트리밍이 코드 채널만 빠져 있었다. 사용자가 실제로 오래
// 기다리는 곳이 코드 채널이라 여기가 제일 아쉬웠다 — answerInCode의 complete에 onChunk를 배선한다.
// 확정 전 원시 펜스(ask_user/engram:propose)가 새는 문제는 messenger-bridge의 펜스 가드가 막는다.
describe('코드 채널 — 답변 실시간 스트리밍·노력(effort)', () => {
  // brain.complete가 받은 (onChunk, opts)를 캡처하는 orchestrator.
  function makeSpyOrch(brainText: string) {
    const seen: { chunks: string[]; opts?: any } = { chunks: [] };
    const brain = {
      complete: async (_p: string, onChunk?: (t: string) => void, opts?: any) => {
        seen.opts = opts;
        for (const c of brainText.split('')) onChunk?.(c);
        return { text: brainText, costUsd: 0, isError: false };
      },
    } as any;
    const conversations = { append: async () => {}, recent: async () => [] } as any;
    const o = new Orchestrator(
      null as any, conversations, logger, null as any,
      null as any, null as any, null as any, null as any,
      {} as any, null as any, null as any, null as any, null as any,
      brain, { assertWritable() {} } as any, null as any, { all: () => [] } as any, null as any,
    );
    return { o, seen };
  }

  it('handleMention의 delta가 codeBrain.complete의 onChunk로 관통한다', async () => {
    const { o, seen } = makeSpyOrch('되는데요');
    const { post } = collect();
    const streamed: string[] = [];
    await o.handleMention(
      { text: '이거 왜 이래?', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' },
      post, 'c1', undefined, (t) => { streamed.push(t); },
    );
    expect(streamed.join('')).toBe('되는데요');
    expect(seen.chunks).toEqual([]); // 캡처용 필드 — 스트림은 delta로만 나간다
  });

  it('delta 미전달(기존 3인자 호출)이면 complete의 onChunk도 undefined다(회귀 0)', async () => {
    let captured: unknown = 'unset';
    const brain = {
      complete: async (_p: string, onChunk?: any) => { captured = onChunk; return { text: '답', costUsd: 0, isError: false }; },
    } as any;
    const conversations = { append: async () => {}, recent: async () => [] } as any;
    const o = new Orchestrator(
      null as any, conversations, logger, null as any,
      null as any, null as any, null as any, null as any,
      {} as any, null as any, null as any, null as any, null as any,
      brain, { assertWritable() {} } as any, null as any, { all: () => [] } as any, null as any,
    );
    const { post } = collect();
    await o.handleMention({ text: 'q', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1');
    expect(captured).toBeUndefined();
  });

  it('코드 채널에 저장된 노력이 없으면 high로 내려간다', async () => {
    const { o, seen } = makeSpyOrch('답');
    const { post } = collect();
    await o.handleMention({ text: 'q', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1');
    expect(seen.opts?.effort).toBe('high');
  });

  it('코드 채널에 저장된 노력이 있으면 그 값이 내려간다', async () => {
    const { o, seen } = makeSpyOrch('답');
    const { post } = collect();
    await o.handleMention(
      { text: 'q', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app', effort: 'max' } as any, post, 'c1',
    );
    expect(seen.opts?.effort).toBe('max');
  });

  it('노력을 실어도 기존 extraArgs(읽기전용 도구·add-dir)는 그대로다(회귀 0)', async () => {
    const { o, seen } = makeSpyOrch('답');
    const { post } = collect();
    await o.handleMention({ text: 'q', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1');
    expect(seen.opts?.extraArgs).toEqual(['--allowedTools', 'Read,Glob,Grep,WebSearch,WebFetch', '--add-dir', 'C:/repo/app']);
    expect(seen.opts?.cwd).toBe('C:/repo/app');
  });
});
