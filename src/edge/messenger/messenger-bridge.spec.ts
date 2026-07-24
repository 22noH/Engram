import { FakeMessenger } from './fake-messenger';
import { bindMessenger } from './messenger-bridge';

const logger = { warn() {} } as any;

it('멘션 → handleMention에 {text,userId=channelId}·post·threadKey 전달', async () => {
  const m = new FakeMessenger();
  const seen: any = {};
  const orch = { handleMention: async (msg: any, post: any, threadKey: any) => { seen.msg = msg; seen.threadKey = threadKey; await post('답'); } };
  bindMessenger(m, orch as any, logger);
  await m.emit({ text: '안녕', channelId: 'c1', threadId: 't1', authorId: 'u1', target: 'T1' });
  expect(seen.msg).toEqual({ text: '안녕', userId: 'c1' });
  expect(seen.threadKey).toBe('t1');
  expect(m.replies).toEqual([{ target: 'T1', text: '답' }]);
});

it('threadId 없으면 channelId가 threadKey', async () => {
  const m = new FakeMessenger();
  let tk: any;
  const orch = { handleMention: async (_m: any, _p: any, threadKey: any) => { tk = threadKey; } };
  bindMessenger(m, orch as any, logger);
  await m.emit({ text: 'x', channelId: 'c1', authorId: 'u1', target: 'T' });
  expect(tk).toBe('c1');
});

it('post는 그 target으로 reply(여러 번 게시 가능)', async () => {
  const m = new FakeMessenger();
  const orch = { handleMention: async (_m: any, post: any) => { await post('알아볼게요'); await post('결과'); } };
  bindMessenger(m, orch as any, logger);
  await m.emit({ text: 'x', channelId: 'c1', authorId: 'u1', target: 'T1' });
  expect(m.replies.map((r) => r.text)).toEqual(['알아볼게요', '결과']);
});

it('handleMention이 던지면 사과 + 로그(상주 불사)', async () => {
  const m = new FakeMessenger();
  const warns: string[] = [];
  const orch = { handleMention: async () => { throw new Error('boom'); } };
  bindMessenger(m, orch as any, { warn: (msg: string) => warns.push(msg) } as any);
  await m.emit({ text: 'x', channelId: 'c1', authorId: 'u1', target: 'T1' });
  expect(m.replies[0].text).toContain("Can't handle that right now");
  expect(warns.length).toBe(1);
});

const OBS_POLICY = { channels: { obs: { observe: true } } } as any; // obs 채널만 opt-in

it('observe opt-in 채널의 일반 메시지 → orchestrator.observe(postToChannel 경유)', async () => {
  const port = new FakeMessenger();
  const seen: string[] = [];
  const orchestrator = {
    handleMention: async () => {},
    observe: async (msg: any, post: any) => { seen.push(msg.userId + ':' + msg.text); await post('💡 힌트'); },
  };
  bindMessenger(port, orchestrator as any, { warn() {} } as any, OBS_POLICY);
  await port.emitMessage({ text: '일반 대화', channelId: 'obs', authorId: 'u1', target: null });
  expect(seen).toEqual(['obs:일반 대화']);
  expect(port.channelPosts).toEqual([{ channelId: 'obs', threadId: undefined, text: '💡 힌트' }]);
});

it('opt-in 아닌 채널 → observe 미호출', async () => {
  const port = new FakeMessenger();
  let called = false;
  const orchestrator = { handleMention: async () => {}, observe: async () => { called = true; } };
  bindMessenger(port, orchestrator as any, { warn() {} } as any, OBS_POLICY);
  await port.emitMessage({ text: '일반 대화', channelId: 'other', authorId: 'u1', target: null });
  expect(called).toBe(false);
});

it('policy 미전달(기존 호출) → onMessage 미바인딩·무파손', async () => {
  const port = new FakeMessenger();
  let called = false;
  const orchestrator = { handleMention: async () => {}, observe: async () => { called = true; } };
  bindMessenger(port, orchestrator as any, { warn() {} } as any);
  await port.emitMessage({ text: '일반 대화', channelId: 'obs', authorId: 'u1', target: null });
  expect(called).toBe(false);
});

it('observe가 throw해도 상주 불사(warn 로그)', async () => {
  const port = new FakeMessenger();
  const warns: string[] = [];
  const orchestrator = { handleMention: async () => {}, observe: async () => { throw new Error('boom'); } };
  bindMessenger(port, orchestrator as any, { warn(m: string) { warns.push(m); } } as any, OBS_POLICY);
  await port.emitMessage({ text: '일반 대화', channelId: 'obs', authorId: 'u1', target: null });
  expect(warns.length).toBe(1);
});

it('mention 이벤트의 mode/repoPath를 handleMention에 넘긴다', async () => {
  const calls: any[] = [];
  const orch = { handleMention: async (m: any) => { calls.push(m); } };
  const port = new FakeMessenger();
  bindMessenger(port, orch as any, { warn() {} });
  await port.emit({ text: 'x', channelId: 'c1', authorId: 'u', target: {}, mode: 'code', repoPath: 'C:/r' });
  expect(calls[0].mode).toBe('code');
  expect(calls[0].repoPath).toBe('C:/r');
});

it('mode가 없는 mention은 mode 필드를 포함하지 않는다(후방호환)', async () => {
  const calls: any[] = [];
  const orch = { handleMention: async (m: any) => { calls.push(m); } };
  const port = new FakeMessenger();
  bindMessenger(port, orch as any, { warn() {} });
  await port.emit({ text: 'x', channelId: 'c1', authorId: 'u', target: {} });
  expect('mode' in calls[0]).toBe(false);
  expect('repoPath' in calls[0]).toBe(false);
});

it('answeredQuestion이 실린 mention은 text 앞에 질문 문맥을 붙여 handleMention에 넘긴다(최종 리뷰 픽스)', async () => {
  const calls: any[] = [];
  const orch = { handleMention: async (m: any) => { calls.push(m); } };
  const port = new FakeMessenger();
  bindMessenger(port, orch as any, { warn() {} });
  await port.emit({ text: 'A로 할게요', channelId: 'c1', authorId: 'u', target: {}, answeredQuestion: '어느 쪽?\n1. A\n2. B' } as any);
  expect(calls[0].text).toBe('[The user answered this question]\n어느 쪽?\n1. A\n2. B\n[Answer]\nA로 할게요');
});

it('answeredQuestion 없는 mention은 text가 원문 그대로다(회귀 0)', async () => {
  const calls: any[] = [];
  const orch = { handleMention: async (m: any) => { calls.push(m); } };
  const port = new FakeMessenger();
  bindMessenger(port, orch as any, { warn() {} });
  await port.emit({ text: '안녕', channelId: 'c1', authorId: 'u', target: {} });
  expect(calls[0].text).toBe('안녕');
});

it('mention 이벤트의 brain을 handleMention에 넘긴다(Task 2, 스펙 §3.2)', async () => {
  const calls: any[] = [];
  const orch = { handleMention: async (m: any) => { calls.push(m); } };
  const port = new FakeMessenger();
  bindMessenger(port, orch as any, { warn() {} });
  await port.emit({ text: 'x', channelId: 'c1', authorId: 'u', target: {}, brain: 'qwen' });
  expect(calls[0].brain).toBe('qwen');
});

it('brain이 없는 mention은 brain 필드를 포함하지 않는다(후방호환)', async () => {
  const calls: any[] = [];
  const orch = { handleMention: async (m: any) => { calls.push(m); } };
  const port = new FakeMessenger();
  bindMessenger(port, orch as any, { warn() {} });
  await port.emit({ text: 'x', channelId: 'c1', authorId: 'u', target: {} });
  expect('brain' in calls[0]).toBe(false);
});

it('observe로 흐르는 일반 메시지의 brain도 함께 넘긴다', async () => {
  const seen: any[] = [];
  const orchestrator = {
    handleMention: async () => {},
    observe: async (msg: any) => { seen.push(msg); },
  };
  const port = new FakeMessenger();
  bindMessenger(port, orchestrator as any, { warn() {} } as any, OBS_POLICY);
  await port.emitMessage({ text: '일반 대화', channelId: 'obs', authorId: 'u1', target: null, brain: 'qwen' } as any);
  expect(seen[0].brain).toBe('qwen');
});

it('mention 이벤트의 attachments를 handleMention에 넘긴다(Task 3, chat-attachments)', async () => {
  const calls: any[] = [];
  const orch = { handleMention: async (m: any) => { calls.push(m); } };
  const port = new FakeMessenger();
  bindMessenger(port, orch as any, { warn() {} });
  const attachments = [{ id: 'a1', name: 'x.png', mime: 'image/png', size: 3, path: 'C:/data/a1.png' }];
  await port.emit({ text: 'x', channelId: 'c1', authorId: 'u', target: {}, attachments } as any);
  expect(calls[0].attachments).toEqual(attachments);
});

it('attachments 없는 mention은 attachments 필드를 포함하지 않는다(회귀 0)', async () => {
  const calls: any[] = [];
  const orch = { handleMention: async (m: any) => { calls.push(m); } };
  const port = new FakeMessenger();
  bindMessenger(port, orch as any, { warn() {} });
  await port.emit({ text: 'x', channelId: 'c1', authorId: 'u', target: {} });
  expect('attachments' in calls[0]).toBe(false);
});

it('post(text, actions)가 port.reply에 actions를 넘긴다', async () => {
  const replied: any[] = [];
  const port = new FakeMessenger();
  const origReply = port.reply.bind(port);
  port.reply = (t: any, text: string, actions?: any) => { replied.push({ text, actions }); return origReply(t, text); };
  const orch = { handleMention: async (_m: any, post: any) => { await post('완성조건', [{ label: 'x', send: '승인' }]); } };
  bindMessenger(port as any, orch as any, { warn() {} });
  await port.emit({ text: 'q', channelId: 'c1', authorId: 'u', target: {} });
  expect(replied[0].actions).toEqual([{ label: 'x', send: '승인' }]);
});

// 두뇌 활동 표시(Task 1)
it('post(text, actions, question, toolsUsed)가 port.reply의 5번째 인자로 그대로 넘어간다', async () => {
  const replied: any[] = [];
  const port = new FakeMessenger();
  const origReply = port.reply.bind(port);
  port.reply = (t: any, text: string, actions?: any, question?: any, toolsUsed?: any) => {
    replied.push({ text, toolsUsed });
    return origReply(t, text);
  };
  const orch = { handleMention: async (_m: any, post: any) => { await post('답', undefined, undefined, ['web_search', 'fetch_url']); } };
  bindMessenger(port as any, orch as any, { warn() {} });
  await port.emit({ text: 'q', channelId: 'c1', authorId: 'u', target: {} });
  expect(replied[0]).toEqual({ text: '답', toolsUsed: ['web_search', 'fetch_url'] });
});

it('port.activity 지원 어댑터면 채널에 바인딩된 activity fn을 handleMention 4번째 인자로 넘긴다', async () => {
  const port = new FakeMessenger();
  const orch = {
    handleMention: async (_m: any, _post: any, _threadKey: any, activity?: (label: string) => void) => {
      activity?.('웹 검색 중 · web_search');
    },
  };
  bindMessenger(port as any, orch as any, { warn() {} });
  await port.emit({ text: 'q', channelId: 'c1', authorId: 'u', target: {} });
  expect(port.activities).toEqual([{ channelId: 'c1', label: '웹 검색 중 · web_search' }]);
});

it('port.activity 미지원 어댑터면 handleMention에 activity=undefined가 넘어간다(회귀 0)', async () => {
  class NoActivityMessenger extends FakeMessenger {}
  const port = new NoActivityMessenger();
  (port as any).activity = undefined; // 명시적으로 미지원 흉내
  let captured: unknown = 'unset';
  const orch = {
    handleMention: async (_m: any, _post: any, _threadKey: any, activity?: (label: string) => void) => {
      captured = activity;
    },
  };
  bindMessenger(port as any, orch as any, { warn() {} });
  await port.emit({ text: 'q', channelId: 'c1', authorId: 'u', target: {} });
  expect(captured).toBeUndefined();
});

it('activity 콜백이 던져도 상주는 죽지 않는다(never-throw 격리)', async () => {
  const port = new FakeMessenger();
  (port as any).activity = () => { throw new Error('ui boom'); };
  const orch = {
    handleMention: async (_m: any, _post: any, _threadKey: any, activity?: (label: string) => void) => {
      activity?.('아무 라벨'); // 던지지 않고 조용히 격리돼야 여기가 정상 진행된다
    },
  };
  bindMessenger(port as any, orch as any, { warn() {} });
  await port.emit({ text: 'q', channelId: 'c1', authorId: 'u', target: {} }); // throw하면 테스트가 실패로 드러남
});
