import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import WebSocket from 'ws';
import { SelfMessenger, SelfTarget, hasEngramMention, stripEngramMention } from './self.adapter';
import { ChatStore } from './chat-store';
import { MentionEvent } from './messenger.port';

const noLog = { warn: () => {} };

function once<T = unknown>(ws: WebSocket, ev: string): Promise<T> {
  return new Promise((resolve) => ws.once(ev, (d: unknown) => resolve(d as T)));
}
async function nextFrame(ws: WebSocket): Promise<any> {
  const d = await once<Buffer>(ws, 'message');
  return JSON.parse(String(d));
}

describe('SelfMessenger 코어', () => {
  let dir: string;
  let store: ChatStore;
  let sm: SelfMessenger;
  let client: WebSocket;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-self-'));
    store = new ChatStore(dir);
    store.listChannels(); // general 생성
    sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1' }, store, { logger: noLog });
    await sm.start();
    client = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(client, 'open');
  });
  afterEach(async () => {
    client.terminate();
    await sm.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('멘션 유틸: 감지·제거(대소문자 무시)', () => {
    expect(hasEngramMention('@engram 안녕')).toBe(true);
    expect(hasEngramMention('그냥 잡담')).toBe(false);
    expect(stripEngramMention('@Engram  안녕')).toBe('안녕');
  });

  it('send → 영속 + msg 브로드캐스트 + onMention 발화(본류: threadId 없음, anchor=자기 id)', async () => {
    const events: MentionEvent[] = [];
    sm.onMention(async (e) => { events.push(e); });
    client.send(JSON.stringify({ t: 'send', channelId: 'general', text: '@Engram 안녕' }));
    const frame = await nextFrame(client);
    expect(frame.t).toBe('msg');
    expect(frame.message).toMatchObject({ authorId: 'owner', text: '@Engram 안녕' });
    expect(store.history('general')).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('안녕');            // 멘션 토큰 제거
    expect(events[0].threadId).toBeUndefined();      // 본류 → threadKey=channelId 정합
    expect((events[0].target as SelfTarget).anchorId).toBe(frame.message.id);
  });

  it('스레드 안 send → threadId는 항상 미설정(작업 키=채널), target.anchorId=같은 anchor(새 스레드 안 팜)', async () => {
    const events: MentionEvent[] = [];
    sm.onMention(async (e) => { events.push(e); });
    client.send(JSON.stringify({ t: 'send', channelId: 'general', text: 'q', threadId: 'anchor-1' }));
    await nextFrame(client);
    // threadId를 anchor로 채우면 스레드 안 승인 답장이 pending(채널 키)을 못 찾는다 — 항상 undefined.
    expect(events[0].threadId).toBeUndefined();
    expect((events[0].target as SelfTarget).anchorId).toBe('anchor-1');
  });

  it('reply → engram 명의로 anchor 스레드에 영속+브로드캐스트', async () => {
    await sm.reply({ channelId: 'general', anchorId: 'a1' } as SelfTarget, '답입니다');
    const frame = await nextFrame(client);
    expect(frame.message).toMatchObject({ authorId: 'engram', text: '답입니다', threadId: 'a1' });
    expect(store.history('general')[0].threadId).toBe('a1');
  });

  it('reply(actions)가 메시지에 actions를 실어 broadcast한다', async () => {
    const acts = [{ label: '✅ 승인', send: '승인', confirm: '시작?' }, { label: '취소', send: '취소' }];
    await sm.reply({ channelId: 'general', anchorId: 'a1' } as SelfTarget, '완성조건…', acts);
    const frame = await nextFrame(client);
    expect(frame.t).toBe('msg');
    expect(frame.message.actions).toEqual(acts);
    expect(store.history('general').at(-1)?.actions).toEqual(acts);
  });

  it('postToChannel → 본류(threadId 없음) 게시, 클라이언트 0명이어도 영속', async () => {
    client.terminate();
    await sm.postToChannel('general', '예약 발사');
    expect(store.history('general')[0]).toMatchObject({ authorId: 'engram', text: '예약 발사' });
  });

  it('미존재 채널 send → error 프레임, 저장 안 함', async () => {
    client.send(JSON.stringify({ t: 'send', channelId: 'nope', text: 'x' }));
    const frame = await nextFrame(client);
    expect(frame.t).toBe('error');
  });

  it('클라가 authorId를 보내면 그 이름으로 저장한다(자가선언)', async () => {
    client.send(JSON.stringify({ t: 'send', channelId: 'general', text: 'hi', authorId: 'alice' }));
    const f = await nextFrame(client);
    expect(f.message.authorId).toBe('alice');
  });

  it('클라가 authorId=engram으로 사칭하면 owner로 강등한다', async () => {
    client.send(JSON.stringify({ t: 'send', channelId: 'general', text: 'hi', authorId: 'Engram' }));
    const f = await nextFrame(client);
    expect(f.message.authorId).toBe('owner');
  });

  it('공백 낀 engram 사칭도 강등한다', async () => {
    client.send(JSON.stringify({ t: 'send', channelId: 'general', text: 'hi', authorId: '  Engram  ' }));
    const f = await nextFrame(client);
    expect(f.message.authorId).toBe('owner');
  });

  it('손상 프레임·빈 text는 무시(서버 불사)', async () => {
    client.send('{broken');
    client.send(JSON.stringify({ t: 'send', channelId: 'general', text: '  ' }));
    client.send(JSON.stringify({ t: 'send', channelId: 'general', text: 'ok' }));
    const frame = await nextFrame(client);
    expect(frame.message.text).toBe('ok');
  });

  it('GET / 는 chat.html을 서빙하지 않고 200 헬스만 응답한다', async () => {
    const res = await fetch(`http://127.0.0.1:${sm.addressPort()}/`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // 임의 경로는 404(기존 성질 유지)
    const res2 = await fetch(`http://127.0.0.1:${sm.addressPort()}/nope`);
    expect(res2.status).toBe(404);
  });
});

it('포트가 이미 점유돼도 상주를 죽이지 않는다(두 번째 start는 reject만)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-'));
  const store = new ChatStore(dir);
  const logs: string[] = [];
  const log = { warn: (m: string) => logs.push(m) };
  const a = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1' }, store, { logger: log });
  await a.start();
  const port = a.addressPort();
  const b = new SelfMessenger({ enabled: true, port, bind: '127.0.0.1' }, store, { logger: log });
  // 두 번째는 EADDRINUSE로 reject 되어야 하고, uncaught로 프로세스를 죽이면 안 된다.
  await expect(b.start()).rejects.toBeDefined();
  await a.stop();
  await b.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SelfMessenger 프로토콜 확장', () => {
  let dir: string;
  let store: ChatStore;
  let sm: SelfMessenger;
  let client: WebSocket;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-self2-'));
    store = new ChatStore(dir);
    store.listChannels();
    sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1' }, store, { logger: noLog });
    await sm.start();
    client = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(client, 'open');
  });
  afterEach(async () => {
    client.terminate();
    await sm.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('channels 요청 → 목록 응답', async () => {
    client.send(JSON.stringify({ t: 'channels' }));
    const f = await nextFrame(client);
    expect(f.t).toBe('channels');
    expect(f.list[0].id).toBe('general');
  });

  it('createChannel → 생성 + channels 브로드캐스트', async () => {
    client.send(JSON.stringify({ t: 'createChannel', name: 'dev' }));
    const f = await nextFrame(client);
    expect(f.t).toBe('channels');
    expect(f.list.map((c: { name: string }) => c.name)).toContain('dev');
  });

  it('deleteChannel·setRespondMode → 반영 + 브로드캐스트', async () => {
    const ch = store.createChannel('tmp')!;
    client.send(JSON.stringify({ t: 'setRespondMode', id: ch.id, mode: 'mention' }));
    const f1 = await nextFrame(client);
    expect(f1.list.find((c: { id: string }) => c.id === ch.id).respondMode).toBe('mention');
    client.send(JSON.stringify({ t: 'deleteChannel', id: ch.id }));
    const f2 = await nextFrame(client);
    expect(f2.list.find((c: { id: string }) => c.id === ch.id)).toBeUndefined();
  });

  it('history 요청 → 저장된 메시지 응답', async () => {
    store.appendMessage('general', { authorId: 'owner', text: 'old' });
    client.send(JSON.stringify({ t: 'history', channelId: 'general' }));
    const f = await nextFrame(client);
    expect(f.t).toBe('history');
    expect(f.messages.map((m: { text: string }) => m.text)).toEqual(['old']);
  });

  it("respondMode='mention': 멘션은 onMention, 비멘션은 onMessage(관찰)", async () => {
    const ch = store.createChannel('team')!;
    store.setRespondMode(ch.id, 'mention');
    const mentions: string[] = [];
    const observed: string[] = [];
    sm.onMention(async (e) => { mentions.push(e.text); });
    sm.onMessage(async (e) => { observed.push(e.text); });
    client.send(JSON.stringify({ t: 'send', channelId: ch.id, text: '@Engram 회의 잡아줘' }));
    await nextFrame(client);
    client.send(JSON.stringify({ t: 'send', channelId: ch.id, text: '그냥 잡담' }));
    await nextFrame(client);
    expect(mentions).toEqual(['회의 잡아줘']);
    expect(observed).toEqual(['그냥 잡담']);
  });

  it('Code 채널 send는 mention 이벤트에 mode/repoPath를 싣는다', async () => {
    const ch = store.createChannel('build', 'code')!;
    store.setRepoPath(ch.id, 'C:/repo/app');
    const events: MentionEvent[] = [];
    sm.onMention(async (e) => { events.push(e); });
    client.send(JSON.stringify({ t: 'send', channelId: ch.id, text: '@Engram 로그인 붙여줘' }));
    await nextFrame(client);
    expect(events).toHaveLength(1);
    expect(events[0].mode).toBe('code');
    expect(events[0].repoPath).toBe('C:/repo/app');
  });

  it('일반(chat) 채널 send는 mention 이벤트에 mode/repoPath를 싣지 않는다', async () => {
    const events: MentionEvent[] = [];
    sm.onMention(async (e) => { events.push(e); });
    client.send(JSON.stringify({ t: 'send', channelId: 'general', text: '@Engram 안녕' }));
    await nextFrame(client);
    expect(events).toHaveLength(1);
    expect(events[0].mode).toBeUndefined();
    expect(events[0].repoPath).toBeUndefined();
    expect('mode' in events[0]).toBe(false);
    expect('repoPath' in events[0]).toBe(false);
  });

  it('setRepoPath 프레임이 채널에 경로를 바인딩하고 channels를 브로드캐스트한다', async () => {
    const ch = store.createChannel('build', 'code')!;
    client.send(JSON.stringify({ t: 'setRepoPath', id: ch.id, repoPath: 'C:/repo/app' }));
    const f = await nextFrame(client);
    expect(f.t).toBe('channels');
    expect(f.list.find((c: { id: string }) => c.id === ch.id).repoPath).toBe('C:/repo/app');
  });

  it('createChannel 프레임의 mode가 전달된다', async () => {
    client.send(JSON.stringify({ t: 'createChannel', name: 'coder', mode: 'code' }));
    const f = await nextFrame(client);
    expect(f.t).toBe('channels');
    expect(f.list.find((c: { name: string }) => c.name === 'coder').mode).toBe('code');
  });

  it("createChannel 프레임의 mode='team'이 전달된다", async () => {
    client.send(JSON.stringify({ t: 'createChannel', name: 'people', mode: 'team' }));
    const f = await nextFrame(client);
    expect(f.t).toBe('channels');
    expect(f.list.find((c: { name: string }) => c.name === 'people').mode).toBe('team');
  });
});

describe('SelfMessenger 인증(토큰)', () => {
  let dir: string;
  let store: ChatStore;
  let sm: SelfMessenger;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-auth-'));
    store = new ChatStore(dir);
    store.listChannels(); // general 생성
    sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', token: 'sekret' }, store, { logger: noLog });
    await sm.start();
  });
  afterEach(async () => {
    await sm.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('올바른 auth 후 channels 프레임이 처리된다', async () => {
    const c = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(c, 'open');
    c.send(JSON.stringify({ t: 'auth', token: 'sekret' }));
    c.send(JSON.stringify({ t: 'channels' }));
    const f = await nextFrame(c);
    expect(f.t).toBe('channels');
    c.terminate();
  });

  it('틀린 토큰 → authErr 후 서버가 소켓을 닫는다', async () => {
    const c = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(c, 'open');
    c.send(JSON.stringify({ t: 'auth', token: 'wrong' }));
    const f = await nextFrame(c);
    expect(f.t).toBe('authErr');
    await once(c, 'close');
    c.terminate();
  });

  it('auth 없이 바로 channels → authErr(미처리)', async () => {
    const c = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(c, 'open');
    c.send(JSON.stringify({ t: 'channels' }));
    const f = await nextFrame(c);
    expect(f.t).toBe('authErr');
    c.terminate();
  });

  it('인증된 소켓의 브로드캐스트는 미인증 소켓에 격리된다', async () => {
    const authed = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(authed, 'open');
    authed.send(JSON.stringify({ t: 'auth', token: 'sekret' }));

    const silent = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(silent, 'open');
    const silentMsgs: unknown[] = [];
    silent.on('message', (d) => silentMsgs.push(JSON.parse(String(d))));

    authed.send(JSON.stringify({ t: 'createChannel', name: 'iso-test' }));
    const f = await nextFrame(authed);
    expect(f.t).toBe('channels');
    expect(f.list.map((c: { name: string }) => c.name)).toContain('iso-test');

    // 짧은 대기 후에도 미인증 소켓은 브로드캐스트를 하나도 못 받았어야 한다.
    await new Promise((r) => setTimeout(r, 50));
    expect(silentMsgs).toEqual([]);

    authed.terminate();
    silent.terminate();
  });

  // jest 가짜 타이머(useFakeTimers)로 서버측 setTimeout만 전진시켜봤으나, 콜백은 즉시(≈25ms) 실행돼도
  // 실제 소켓으로의 authErr 프레임 도달은 여전히 ≈5000ms 실시간이 걸렸다(fake timer↔실 ws 소켓 I/O 간
  // 알 수 없는 상호작용 — 속도 이득이 없어 fake로 얻는 게 없다). 그래서 실시간 대기로 단순화 —
  // 결정적이며(5초 타임아웃은 서버 상수) 매직도 없다. 테스트 자체 timeout만 여유있게 늘린다.
  it('5초간 침묵하면 auth 타임아웃 → authErr 전송 후 소켓을 닫는다', async () => {
    const c = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(c, 'open');
    const framePromise = nextFrame(c);
    const closePromise = once(c, 'close');
    const f = await framePromise;
    expect(f.t).toBe('authErr');
    await closePromise;
    c.terminate();
  }, 8000);
});
