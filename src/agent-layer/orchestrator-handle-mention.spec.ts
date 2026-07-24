import { Orchestrator } from './orchestrator';
import { questionFallbackText } from './ask-user-block';

const logger = { warn() {}, error() {}, log() {} } as any;

// 생성자: (reader, conversations, logger, ingester, tasks, specialist, synth, sem,
//          projects, gate, codingGit, coder, reviewer, codeBrain, fence, reporter, registry)
function orc(brainText: string, registryNames: string[] = ['Manager', 'Infra']) {
  const brain = { complete: async () => ({ text: brainText, costUsd: 0, isError: false }) } as any;
  const registry = { all: () => registryNames.map((name) => ({ name, role: 'r', brain: 'claude', tools: [], invocation: ['summon'], prompt: '' })) } as any;
  const conversations = { append: async () => {} } as any; // launchCollaboration이 결과를 적재
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any, null as any,
    brain, null as any, null as any, registry,
  );
  return o;
}

it('분류 collaborate → ack 후 백그라운드 결과 post', async () => {
  const o = orc('{"kind":"collaborate","team":["Manager","Infra"]}');
  (o as any).collaborate = async () => '종합';
  const posts: string[] = [];
  await o.handleMention({ text: '서버 비용 줄여줘', userId: 'c1' }, async (t) => { posts.push(t); });
  await (o as any).drainForTest();
  expect(posts[0]).toContain('looking into it');
  expect(posts).toContain('종합');
});

it('collaborate 팀이 ack 문구에 들어감', async () => {
  const o = orc('{"kind":"collaborate","team":["Manager","Infra"]}');
  (o as any).collaborate = async () => 'x';
  const posts: string[] = [];
  await o.handleMention({ text: 'q', userId: 'c1' }, async (t) => { posts.push(t); });
  await (o as any).drainForTest();
  expect(posts[0]).toContain('Manager');
  expect(posts[0]).toContain('Infra');
});

it('분류 chat → 답을 post', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  (o as any).route = async () => '즉답';
  const posts: string[] = [];
  await o.handleMention({ text: '엔그램이 뭐야?', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(posts).toEqual(['즉답']);
});

it('분류 응답이 깨지면 chat 폴백', async () => {
  const o = orc('이건 JSON이 아님');
  let routed = false;
  (o as any).route = async () => { routed = true; return 'r'; };
  await o.handleMention({ text: 'x', userId: 'c1' }, async () => {});
  expect(routed).toBe(true);
});

it('collaborate인데 team이 비면 [Manager] 폴백', async () => {
  const o = orc('{"kind":"collaborate","team":[]}');
  let used: string[] = [];
  (o as any).collaborate = async (_q: string, team: string[]) => { used = team; return 'x'; };
  await o.handleMention({ text: 'x', userId: 'c1' }, async () => {});
  await (o as any).drainForTest();
  expect(used).toEqual(['Manager']);
});

it('escape hatch "team a,b 질문" → 백그라운드 collaborate', async () => {
  const o = orc('{"kind":"chat","team":[]}'); // 분류 chat이어도 무시
  const calls: any[] = [];
  (o as any).collaborate = async (q: string, team: string[]) => { calls.push({ q, team }); return 'x'; };
  await o.handleMention({ text: 'team Brand,Trend 런칭 전략?', userId: 'c1' }, async () => {});
  await (o as any).drainForTest();
  expect(calls[0]).toEqual({ q: '런칭 전략?', team: ['Brand', 'Trend'] });
});

it('escape hatch "ask 질문" → chat route', async () => {
  const o = orc('{"kind":"collaborate","team":["X"]}'); // 무시돼야
  (o as any).route = async (m: any) => `r:${m.text}`;
  const posts: string[] = [];
  await o.handleMention({ text: 'ask 엔그램이 뭐야', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(posts).toEqual(['r:엔그램이 뭐야']);
});

it('상태 → 진행 중 작업 보고', async () => {
  const o = orc('{"kind":"collaborate","team":["Manager"]}');
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  (o as any).collaborate = async () => { await gate; return '결과'; };
  await o.handleMention({ text: '분석해줘', userId: 'c1' }, async () => {}); // 백그라운드 시작(미완)
  const statusPosts: string[] = [];
  await o.handleMention({ text: '상태', userId: 'c1' }, async (t) => { statusPosts.push(t); });
  expect(statusPosts[0]).toContain('In progress');
  release();
  await (o as any).drainForTest();
});

it('상태 — 작업 없으면 안내', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  const posts: string[] = [];
  await o.handleMention({ text: 'status', userId: 'c9' }, async (t) => { posts.push(t); });
  expect(posts[0]).toContain('No tasks currently running');
});

it('백그라운드 실패 → 사과 post(상주 불사)', async () => {
  const o = orc('{"kind":"collaborate","team":["Manager"]}');
  (o as any).collaborate = async () => { throw new Error('boom'); };
  const posts: string[] = [];
  await o.handleMention({ text: 'q', userId: 'c1' }, async (t) => { posts.push(t); });
  await (o as any).drainForTest();
  expect(posts.some((p) => p.includes('Something went wrong'))).toBe(true);
});

it('상태 — 실패한 작업은 (실패)로 표시', async () => {
  const o = orc('{"kind":"collaborate","team":["Manager"]}');
  (o as any).collaborate = async () => { throw new Error('boom'); };
  await o.handleMention({ text: '분석', userId: 'c1' }, async () => {});
  await (o as any).drainForTest();
  const posts: string[] = [];
  await o.handleMention({ text: '상태', userId: 'c1' }, async (t) => { posts.push(t); });
  expect(posts[0]).toContain('(failed)');
});

// ask-user 범용 경로(Task 3): 두뇌 최종 응답(route 경유)에 ```ask_user 블록이 있으면 post가
// question 인자와 함께 호출되고, 블록은 게시 text에서 빠진다.
it('chat 응답에 ask_user 블록 있으면 post가 question 인자와 함께 호출된다', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  const block = [
    '두 방향이 있어요.',
    '',
    '```ask_user',
    JSON.stringify({ questions: [{ q: '어느 쪽?', options: [{ label: 'A' }, { label: 'B' }] }] }),
    '```',
  ].join('\n');
  (o as any).route = async () => block;
  const calls: Array<{ text: string; actions?: any; question?: any }> = [];
  await o.handleMention({ text: '결정해줘', userId: 'c1' }, async (text, actions, question) => {
    calls.push({ text, actions, question });
  });
  expect(calls).toHaveLength(1);
  expect(calls[0].text).toBe('두 방향이 있어요.');
  expect(calls[0].actions).toBeUndefined();
  expect(calls[0].question).toEqual({ questions: [{ q: '어느 쪽?', options: [{ label: 'A' }, { label: 'B' }] }] });
});

it('chat 응답에 ask_user 블록이 없으면 question 인자 없이 post된다(회귀 0)', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  (o as any).route = async () => '즉답';
  const calls: Array<{ text: string; actions?: any; question?: any }> = [];
  await o.handleMention({ text: '엔그램이 뭐야?', userId: 'c1' }, async (text, actions, question) => {
    calls.push({ text, actions, question });
  });
  expect(calls).toEqual([{ text: '즉답', actions: undefined, question: undefined }]);
});

it('ask_user 블록만 있고 본문 없으면 폴백 텍스트가 게시된다', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  const block = [
    '```ask_user',
    JSON.stringify({ questions: [{ q: '진행할까요?', options: [{ label: '예' }, { label: '아니오' }] }] }),
    '```',
  ].join('\n');
  (o as any).route = async () => block;
  const calls: Array<{ text: string; question?: any }> = [];
  await o.handleMention({ text: 'x', userId: 'c1' }, async (text, _actions, question) => {
    calls.push({ text, question });
  });
  expect(calls[0].text).toBe('진행할까요?\n1. 예\n2. 아니오');
  expect(calls[0].question).toBeDefined();
});

// ask_user 도구 경로(Task 4, 리뷰 minor): reader.handle에 주입되는 askUser 클로저(orchestrator.ts의
// askUserFor)가 실제로 post를 (fallbackText, undefined, question)으로 부르는지 handleMention() 경유로
// 확인한다 — route()·postReply를 오버라이드하지 않고 실제 배선을 그대로 태운다(reader만 스텁: 두뇌
// 도구호출이 CompleteOpts.askUser를 부르는 상황을 흉내).
it('askUserFor 클로저: brain이 주입된 askUser를 부르면 post가 (fallbackText, undefined, question)으로 불린다', async () => {
  const question = { questions: [{ q: '어느 브랜치?', options: [{ label: 'main' }, { label: 'staging' }] }] };
  const reader = {
    handle: async (_msg: any, _onChunk: any, _onSources: any, askUser: any) => {
      await askUser(question); // anthropic-api/openai-api의 ask_user 도구 실행이 여기서 이 클로저를 부른다
      return '요약';
    },
  } as any;
  const brain = { complete: async () => ({ text: '{"kind":"chat","team":[]}', costUsd: 0, isError: false }) } as any;
  const conversations = { append: async () => {} } as any;
  const o = new Orchestrator(
    reader, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any, null as any,
    brain, null as any, null as any, null as any,
  );
  const calls: Array<{ text: string; actions?: any; question?: any }> = [];
  await o.handleMention({ text: '결정해줘', userId: 'c1' }, async (text, actions, q) => {
    calls.push({ text, actions, question: q });
  });
  expect(calls[0]).toEqual({ text: questionFallbackText(question), actions: undefined, question });
});

// 두뇌 활동 표시(Task 1): handleMention 4번째 인자(activity)가 reader.handle까지 그대로(5번째 인자)
// 통과하는지, 그리고 reader.handle이 onToolsUsed(6번째 인자)로 통지한 도구 이름들이 최종 post의
// 4번째 인자(toolsUsed)로 동봉되는지 — postReply·route를 오버라이드하지 않고 실배선을 태운다.
describe('두뇌 활동 표시(Task 1) — activity 관통·toolsUsed 동봉', () => {
  function orcWithReader(reader: any) {
    const brain = { complete: async () => ({ text: '{"kind":"chat","team":[]}', costUsd: 0, isError: false }) } as any;
    const conversations = { append: async () => {} } as any;
    return new Orchestrator(
      reader, conversations, logger, null as any,
      null as any, null as any, null as any, null as any,
      null as any, null as any, null as any, null as any, null as any,
      brain, null as any, null as any, null as any,
    );
  }

  it('handleMention에 넘긴 activity가 reader.handle의 5번째 인자로 그대로 전달된다', async () => {
    let captured: unknown;
    const reader = {
      handle: async (_msg: any, _onChunk: any, _onSources: any, _askUser: any, activityArg: any) => {
        captured = activityArg;
        return '답';
      },
    };
    const activity = (_label: string): void => {};
    const o = orcWithReader(reader);
    await o.handleMention({ text: 'q', userId: 'c1' }, async () => {}, undefined, activity);
    expect(captured).toBe(activity);
  });

  it('activity 미전달(3인자 호출)이면 reader.handle에도 undefined가 전달된다(회귀 0)', async () => {
    let captured: unknown = 'unset';
    const reader = {
      handle: async (_msg: any, _onChunk: any, _onSources: any, _askUser: any, activityArg: any) => {
        captured = activityArg;
        return '답';
      },
    };
    const o = orcWithReader(reader);
    await o.handleMention({ text: 'q', userId: 'c1' }, async () => {});
    expect(captured).toBeUndefined();
  });

  it('reader.handle이 onToolsUsed로 통지한 도구 이름이 최종 post에 toolsUsed로 동봉된다', async () => {
    const reader = {
      handle: async (_msg: any, _onChunk: any, _onSources: any, _askUser: any, _activity: any, onToolsUsed: any) => {
        onToolsUsed?.(['web_search', 'fetch_url']);
        return '답';
      },
    };
    const o = orcWithReader(reader);
    const calls: Array<{ text: string; toolsUsed?: string[] }> = [];
    await o.handleMention({ text: 'q', userId: 'c1' }, async (text, _actions, _question, toolsUsed) => {
      calls.push({ text, toolsUsed });
    });
    expect(calls).toEqual([{ text: '답', toolsUsed: ['web_search', 'fetch_url'] }]);
  });

  it('도구를 안 쓰면 post에 빈 배열이 실린다(빈 배열 폐기는 self.adapter/chat-store 몫)', async () => {
    const reader = {
      handle: async (_msg: any, _onChunk: any, _onSources: any, _askUser: any, _activity: any, onToolsUsed: any) => {
        onToolsUsed?.([]);
        return '답';
      },
    };
    const o = orcWithReader(reader);
    const calls: Array<{ toolsUsed?: string[] }> = [];
    await o.handleMention({ text: 'q', userId: 'c1' }, async (_text, _actions, _question, toolsUsed) => {
      calls.push({ toolsUsed });
    });
    expect(calls[0].toolsUsed).toEqual([]);
  });
});
