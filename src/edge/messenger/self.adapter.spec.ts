import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SelfMessenger, SelfTarget, hasEngramMention, stripEngramMention } from './self.adapter';
import { ChatStore } from './chat-store';
import { MentionEvent } from './messenger.port';
import type { WikiPage } from '../../knowledge-core/wiki/page.types';
import type { Proposal } from '../../knowledge-core/proposal-store';
import { AccountStore, Account } from '../auth/account-store';
import { SessionStore } from '../auth/session-store';
import { AuthHttp } from '../auth/auth-http';
import type { AuthDeps } from './self.adapter';
import type { AdminSettings } from '../../../shared/protocol';
import type { McpDeps } from '../mcp/engram-mcp';
import * as mcpHttp from '../mcp/mcp-http';
import { AdminHttp } from '../admin/admin-http';
import type { AdminDeps } from './self.adapter';

function makeAuthDeps(dir: string): AuthDeps {
  const accounts = new AccountStore(dir);
  const sessions = new SessionStore(dir);
  const http = new AuthHttp({ accounts, sessions, stateDir: dir, settings: { load: () => ({}) }, delayMs: 0 });
  return { accounts, sessions, http, settings: { load: () => ({}), save: () => {} } };
}

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
    sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog });
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

  it('무인증 모드는 클라 authorId 주장을 무시하고 owner로 고정한다(Phase16a: Phase14 자가선언 폐기)', async () => {
    for (const claimed of ['alice', 'Engram', '  Engram  ']) {
      client.send(JSON.stringify({ t: 'send', channelId: 'general', text: 'hi', authorId: claimed }));
      const f = await nextFrame(client);
      expect(f.message.authorId).toBe('owner');
    }
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
  const a = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: log });
  await a.start();
  const port = a.addressPort();
  const b = new SelfMessenger({ enabled: true, port, bind: '127.0.0.1', role: 'server' }, store, { logger: log });
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
    sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog });
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

  it('브레인이 설정된 채널 send는 mention 이벤트에 brain을 싣는다(스펙 §3.2, 멘션 흐름 스파이)', async () => {
    const ch = store.createChannel('coding')!;
    store.setChannelBrain(ch.id, 'qwen');
    const events: MentionEvent[] = [];
    sm.onMention(async (e) => { events.push(e); });
    client.send(JSON.stringify({ t: 'send', channelId: ch.id, text: '@Engram 안녕' }));
    await nextFrame(client);
    expect(events).toHaveLength(1);
    expect(events[0].brain).toBe('qwen');
  });

  it('브레인 미설정 채널 send는 mention 이벤트에 brain 필드가 아예 없다(미설정 채널=회귀 0)', async () => {
    const events: MentionEvent[] = [];
    sm.onMention(async (e) => { events.push(e); });
    client.send(JSON.stringify({ t: 'send', channelId: 'general', text: '@Engram 안녕' }));
    await nextFrame(client);
    expect(events).toHaveLength(1);
    expect(events[0].brain).toBeUndefined();
    expect('brain' in events[0]).toBe(false);
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

describe('setChannelBrain(Task 3)', () => {
  let dir: string;
  let store: ChatStore;
  let sm: SelfMessenger;
  let client: WebSocket;
  const names = ['qwen', 'gemma'];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-brainch-'));
    store = new ChatStore(dir);
    store.listChannels();
    sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog, brainNames: () => names, defaultBrain: () => 'claude' });
    await sm.start();
    client = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(client, 'open');
  });
  afterEach(async () => {
    client.terminate();
    await sm.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('등록된 이름으로 설정 성공 → channels 브로드캐스트에 brain·brainNames·defaultBrain 동봉', async () => {
    const ch = store.createChannel('coding')!;
    client.send(JSON.stringify({ t: 'setChannelBrain', id: ch.id, brain: 'qwen' }));
    const f = await nextFrame(client);
    expect(f.t).toBe('channels');
    expect(f.brainNames).toEqual(names);
    expect(f.defaultBrain).toBe('claude');
    expect(f.list.find((c: { id: string; brain?: string }) => c.id === ch.id)?.brain).toBe('qwen');
  });

  it('미등록 이름은 조용히 무시(필드 미반영)', async () => {
    const ch = store.createChannel('coding2')!;
    client.send(JSON.stringify({ t: 'setChannelBrain', id: ch.id, brain: 'bogus' }));
    const f = await nextFrame(client);
    expect(f.list.find((c: { id: string; brain?: string }) => c.id === ch.id)?.brain).toBeUndefined();
  });

  it('brain: null은 검증 없이 허용 — 기존 지정을 해제', async () => {
    const ch = store.createChannel('coding3')!;
    store.setChannelBrain(ch.id, 'qwen');
    client.send(JSON.stringify({ t: 'setChannelBrain', id: ch.id, brain: null }));
    const f = await nextFrame(client);
    expect(f.list.find((c: { id: string; brain?: string }) => c.id === ch.id)?.brain).toBeUndefined();
  });

  it('비문자열·비null brain은 무시', async () => {
    const ch = store.createChannel('coding4')!;
    client.send(JSON.stringify({ t: 'setChannelBrain', id: ch.id, brain: 123 }));
    const f = await nextFrame(client);
    expect(f.list.find((c: { id: string; brain?: string }) => c.id === ch.id)?.brain).toBeUndefined();
  });

  it('channels 요청 응답에도 brainNames·defaultBrain이 동봉된다', async () => {
    client.send(JSON.stringify({ t: 'channels' }));
    const f = await nextFrame(client);
    expect(f.t).toBe('channels');
    expect(f.brainNames).toEqual(names);
    expect(f.defaultBrain).toBe('claude');
  });

  it('brainNames·defaultBrain 미주입이면 빈 목록·빈 문자열(회귀 없음)', async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-brainch2-'));
    const store2 = new ChatStore(dir2);
    store2.listChannels();
    const sm2 = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store2, { logger: noLog });
    await sm2.start();
    const c = new WebSocket(`ws://127.0.0.1:${sm2.addressPort()}`);
    await once(c, 'open');
    c.send(JSON.stringify({ t: 'channels' }));
    const f = await nextFrame(c);
    expect(f.brainNames).toEqual([]);
    expect(f.defaultBrain).toBe('');
    c.terminate();
    await sm2.stop();
    fs.rmSync(dir2, { recursive: true, force: true });
  });
});

describe('setChannelBrain 권한 게이트(Task 3)', () => {
  let dir: string;
  let sm: SelfMessenger | undefined;
  let clients: WebSocket[];
  let deps: AuthDeps;
  const names = ['qwen'];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-brain-'));
    clients = [];
    deps = makeAuthDeps(dir);
  });
  afterEach(async () => {
    for (const c of clients) c.terminate();
    clients = [];
    if (sm) await sm.stop();
    sm = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function connect(): Promise<WebSocket> {
    const c = new WebSocket(`ws://127.0.0.1:${sm!.addressPort()}`);
    await once(c, 'open');
    clients.push(c);
    return c;
  }

  it('channels.manage 보유 member는 남의 채널에도 brain 설정 가능(권한 있는 소켓 성공)', async () => {
    const acc = deps.accounts.createPassword('mem', 'pw', 'Mem', { status: 'active' });
    deps.accounts.setPermissions(acc.id, ['channels.manage']);
    const store = new ChatStore(path.join(dir, 'chat'));
    const ch = store.createChannel('theirs', 'chat', 'other')!;
    sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog, brainNames: () => names }, undefined, deps);
    await sm.start();
    const c = await connect();
    const sess = deps.sessions.issue(acc.id);
    c.send(JSON.stringify({ t: 'auth', token: sess.token }));
    await nextFrame(c); // authOk
    c.send(JSON.stringify({ t: 'setChannelBrain', id: ch.id, brain: 'qwen' }));
    const f = await nextFrame(c);
    expect(f.list.find((x: { id: string; brain?: string }) => x.id === ch.id)?.brain).toBe('qwen');
  });

  it('권한 없는 member의 남의 채널 setChannelBrain은 무시(권한 없는 소켓)', async () => {
    const acc = deps.accounts.createPassword('mem', 'pw', 'Mem', { status: 'active' });
    const store = new ChatStore(path.join(dir, 'chat'));
    const ch = store.createChannel('theirs', 'chat', 'other')!;
    sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog, brainNames: () => names }, undefined, deps);
    await sm.start();
    const c = await connect();
    const sess = deps.sessions.issue(acc.id);
    c.send(JSON.stringify({ t: 'auth', token: sess.token }));
    await nextFrame(c);
    c.send(JSON.stringify({ t: 'setChannelBrain', id: ch.id, brain: 'qwen' }));
    const f = await nextFrame(c);
    expect(f.list.find((x: { id: string; brain?: string }) => x.id === ch.id)?.brain).toBeUndefined();
  });

  it('내가 만든 채널은 channels.manage 없이도 brain 설정 가능(소유권 예외)', async () => {
    const acc = deps.accounts.createPassword('mem', 'pw', 'Mem', { status: 'active' });
    const store = new ChatStore(path.join(dir, 'chat'));
    store.listChannels();
    sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog, brainNames: () => names }, undefined, deps);
    await sm.start();
    const c = await connect();
    const sess = deps.sessions.issue(acc.id);
    c.send(JSON.stringify({ t: 'auth', token: sess.token }));
    await nextFrame(c);
    c.send(JSON.stringify({ t: 'createChannel', name: 'mine' }));
    const f1 = await nextFrame(c);
    const ch = f1.list.find((x: { name: string }) => x.name === 'mine');
    c.send(JSON.stringify({ t: 'setChannelBrain', id: ch.id, brain: 'qwen' }));
    const f2 = await nextFrame(c);
    expect(f2.list.find((x: { id: string; brain?: string }) => x.id === ch.id)?.brain).toBe('qwen');
  });
});

describe('brain 모드(Phase 16a)', () => {
  it('brain 모드: team 채널 생성 무시', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-brain-'));
    const store = new ChatStore(dir);
    store.listChannels();
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'brain' } as any, store, { logger: noLog });
    await sm.start();
    const client = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(client, 'open');
    client.send(JSON.stringify({ t: 'createChannel', name: 'people', mode: 'team' }));
    client.send(JSON.stringify({ t: 'channels' })); // 뒤에 온 프레임이 처리되면 team 요청은 무시된 것
    const f = await nextFrame(client);
    expect(f.t).toBe('channels');
    expect(f.list.find((c: { name: string }) => c.name === 'people')).toBeUndefined();
    client.terminate();
    await sm.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('세션 인증(Phase 16a)', () => {
  let dir: string;
  let sm: SelfMessenger | undefined;
  let clients: WebSocket[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-'));
    clients = [];
  });
  afterEach(async () => {
    for (const c of clients) c.terminate();
    clients = [];
    if (sm) await sm.stop();
    sm = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function makeServer(deps: AuthDeps | undefined): Promise<ChatStore> {
    const store = new ChatStore(path.join(dir, 'chat'));
    store.listChannels(); // general 생성
    sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, undefined, deps);
    await sm.start();
    return store;
  }
  async function connect(): Promise<WebSocket> {
    const c = new WebSocket(`ws://127.0.0.1:${sm!.addressPort()}`);
    await once(c, 'open');
    clients.push(c);
    return c;
  }

  it('유효 세션 auth → authOk(user) + 정상 처리', async () => {
    const deps = makeAuthDeps(dir);
    const acc = deps.accounts.createPassword('kim', 'pw', 'Kim', { status: 'active' });
    const sess = deps.sessions.issue(acc.id);
    await makeServer(deps);
    const c = await connect();
    c.send(JSON.stringify({ t: 'auth', token: sess.token }));
    const f = await nextFrame(c);
    expect(f).toEqual({ t: 'authOk', user: { id: acc.id, displayName: 'Kim', role: 'member', permissions: [] } });
    c.send(JSON.stringify({ t: 'channels' }));
    const f2 = await nextFrame(c);
    expect(f2.t).toBe('channels');
  });

  it('무효/만료 세션 → authErr + 종료', async () => {
    const deps = makeAuthDeps(dir);
    // Task 1(스탠드얼론): 계정0+루프백은 free 소켓이라 이 시나리오와 무관 — 계정을 만들어 "설정된 서버"
    // 전제를 명시적으로 성립시킨다(계정 0개였다면 이 wrong-token auth 자체가 free 경로로 무시된다).
    deps.accounts.createPassword('someone', 'pw', 'Someone', { status: 'active' });
    await makeServer(deps);
    const c = await connect();
    c.send(JSON.stringify({ t: 'auth', token: 'wrong' }));
    const f = await nextFrame(c);
    expect(f.t).toBe('authErr');
    await once(c, 'close');
  });

  it('suspended 계정 세션 → authErr', async () => {
    const deps = makeAuthDeps(dir);
    const acc = deps.accounts.createPassword('kim', 'pw', 'Kim', { status: 'active' });
    const sess = deps.sessions.issue(acc.id);
    deps.accounts.setStatus(acc.id, 'suspended');
    await makeServer(deps);
    const c = await connect();
    c.send(JSON.stringify({ t: 'auth', token: sess.token }));
    const f = await nextFrame(c);
    expect(f.t).toBe('authErr');
  });

  it('send의 작성자는 서버가 세션에서 스탬프(클라 authorId 주장 무시)', async () => {
    const deps = makeAuthDeps(dir);
    const acc = deps.accounts.createPassword('kim', 'pw', 'Kim', { status: 'active' });
    const sess = deps.sessions.issue(acc.id);
    await makeServer(deps);
    const c = await connect();
    c.send(JSON.stringify({ t: 'auth', token: sess.token }));
    await nextFrame(c); // authOk
    c.send(JSON.stringify({ t: 'send', channelId: 'general', text: 'hi', authorId: '사칭engram' }));
    const f = await nextFrame(c);
    expect(f.t).toBe('msg');
    expect(f.message.authorId).toBe(acc.id);
    expect(f.message.authorName).toBe('Kim');
  });

  it('/auth/ http는 AuthHttp로 위임(status 200), 헬스 프로브는 기존대로', async () => {
    const deps = makeAuthDeps(dir);
    await makeServer(deps);
    const res = await fetch(`http://127.0.0.1:${sm!.addressPort()}/auth/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: false, oidc: false });
    const res2 = await fetch(`http://127.0.0.1:${sm!.addressPort()}/`);
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ ok: true });
  });

  it('kickUser: 그 사용자 소켓 즉시 종료', async () => {
    const deps = makeAuthDeps(dir);
    const acc = deps.accounts.createPassword('kim', 'pw', 'Kim', { status: 'active' });
    const sess = deps.sessions.issue(acc.id);
    await makeServer(deps);
    const c = await connect();
    c.send(JSON.stringify({ t: 'auth', token: sess.token }));
    await nextFrame(c); // authOk
    const closePromise = once(c, 'close');
    sm!.kickUser(acc.id);
    await closePromise;
  });

  it('kickUser: authed WeakSet에서도 제거 — kick 이후 in-flight 프레임은 게이트에서 거부(오귀속 방지)', async () => {
    const deps = makeAuthDeps(dir);
    const acc = deps.accounts.createPassword('kim', 'pw', 'Kim', { status: 'active' });
    const sess = deps.sessions.issue(acc.id);
    const store = await makeServer(deps);
    const c = await connect();
    c.send(JSON.stringify({ t: 'auth', token: sess.token }));
    await nextFrame(c); // authOk
    // ws.close()는 비동기 그레이스풀 핸드셰이크라 이미 파싱됐지만 아직 처리되지 않은 'message'
    // 이벤트를 즉시 막지 못한다 — 그 레이스를 서버측 소켓에 직접 재현: kickUser 이후에도
    // handleFrame이 이 소켓을 여전히 인증된 것으로 보면 안 된다(authed에서도 제거돼야 함).
    const serverWs = [...(sm as unknown as { wss: { clients: Set<WebSocket> } }).wss.clients][0];
    const closePromise = once(c, 'close');
    sm!.kickUser(acc.id);
    await closePromise;
    await (sm as unknown as { handleFrame(ws: WebSocket, raw: string): Promise<void> }).handleFrame(
      serverWs,
      JSON.stringify({ t: 'send', channelId: 'general', text: 'sneaky-after-kick' }),
    );
    // 게이트가 거부했다면 메시지가 저장/귀속되지 않는다(오너/유령 귀속 없음).
    expect(store.history('general')).toHaveLength(0);
  });

  it('authDeps 미주입 = 무인증 통과(현행) + authorId owner 고정', async () => {
    await makeServer(undefined);
    const c = await connect();
    c.send(JSON.stringify({ t: 'send', channelId: 'general', text: 'hi', authorId: 'x' }));
    const f = await nextFrame(c);
    expect(f.message.authorId).toBe('owner');
  });

  // jest 가짜 타이머(useFakeTimers)로 서버측 setTimeout만 전진시켜봤으나, 콜백은 즉시(≈25ms) 실행돼도
  // 실제 소켓으로의 authErr 프레임 도달은 여전히 ≈5000ms 실시간이 걸렸다(fake timer↔실 ws 소켓 I/O 간
  // 알 수 없는 상호작용 — 속도 이득이 없어 fake로 얻는 게 없다). 그래서 실시간 대기로 단순화 —
  // 결정적이며(5초 타임아웃은 서버 상수) 매직도 없다. 테스트 자체 timeout만 여유있게 늘린다.
  it('5초간 침묵하면 auth 타임아웃 → authErr 전송 후 소켓을 닫는다', async () => {
    const deps = makeAuthDeps(dir);
    // Task 1: 계정0+루프백이면 free 소켓이라 타임아웃으로 끊기지 않는다 — "설정된 서버" 전제를 성립.
    deps.accounts.createPassword('someone', 'pw', 'Someone', { status: 'active' });
    await makeServer(deps);
    const c = await connect();
    const framePromise = nextFrame(c);
    const closePromise = once(c, 'close');
    const f = await framePromise;
    expect(f.t).toBe('authErr');
    await closePromise;
  }, 8000);
});

describe('스탠드얼론 무인증(Task 1, 설계 §2.1)', () => {
  let dir: string;
  let sm: SelfMessenger | undefined;
  let clients: WebSocket[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-free-'));
    clients = [];
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    for (const c of clients) c.terminate();
    clients = [];
    if (sm) await sm.stop();
    sm = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function makeServer(deps: AuthDeps): Promise<ChatStore> {
    const store = new ChatStore(path.join(dir, 'chat'));
    store.listChannels(); // general 생성
    sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, undefined, deps);
    await sm.start();
    return store;
  }
  async function connect(): Promise<WebSocket> {
    const c = new WebSocket(`ws://127.0.0.1:${sm!.addressPort()}`);
    await once(c, 'open');
    clients.push(c);
    return c;
  }

  it('케이스④: 미설정+루프백 ws는 auth 프레임 없이 채널 프레임을 바로 사용한다(brain 권한 경로 재사용)', async () => {
    const deps = makeAuthDeps(dir); // accounts.count() === 0
    const store = await makeServer(deps);
    const c = await connect();
    c.send(JSON.stringify({ t: 'send', channelId: 'general', text: 'hi' })); // auth 프레임 생략
    const f = await nextFrame(c);
    expect(f.t).toBe('msg');
    expect(f.message.authorId).toBe('owner'); // 무인증(brain 모드)과 동일한 귀속 규칙
    expect(store.history('general')).toHaveLength(1);
  });

  it('케이스⑤: 계정 생성 후에는 같은(이미 연결된) 소켓도 다음 프레임부터 거부된다(캐시 없이 매번 재판정)', async () => {
    const deps = makeAuthDeps(dir);
    const store = await makeServer(deps);
    const c = await connect();
    c.send(JSON.stringify({ t: 'send', channelId: 'general', text: 'first' }));
    const f1 = await nextFrame(c);
    expect(f1.t).toBe('msg'); // 아직 계정 0개 → free 통과

    deps.accounts.createPassword('boss', 'pw', 'Boss', { role: 'owner', status: 'active' }); // 최초 계정 생성

    const closePromise = once(c, 'close');
    c.send(JSON.stringify({ t: 'send', channelId: 'general', text: 'second' })); // 같은 소켓, auth 프레임 없음
    const f2 = await nextFrame(c);
    expect(f2.t).toBe('authErr'); // 현행 거부(설정된 서버와 동일 취급)
    await closePromise;
    expect(store.history('general').map((m) => m.text)).toEqual(['first']); // second는 저장 안 됨
  });

  it('케이스⑥: 비루프백 소켓은 미설정(계정0)이어도 현행 게이트를 유지한다(isLoopback 모킹)', async () => {
    jest.spyOn(mcpHttp, 'isLoopback').mockReturnValue(false);
    const deps = makeAuthDeps(dir); // accounts.count() === 0
    await makeServer(deps);
    const c = await connect();
    c.send(JSON.stringify({ t: 'send', channelId: 'general', text: 'x' })); // auth 프레임 없음
    const closePromise = once(c, 'close');
    const f = await nextFrame(c);
    expect(f.t).toBe('authErr');
    await closePromise;
  });
});

describe('admin 프레임(Phase 16a)', () => {
  let dir: string;
  let sm: SelfMessenger | undefined;
  let clients: WebSocket[];
  let deps: AuthDeps;
  let owner: Account;
  let member: Account;
  let ownerWs: WebSocket;
  let memberWs: WebSocket;
  let memberToken: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-admin-'));
    clients = [];
    deps = makeAuthDeps(dir);
    owner = deps.accounts.createPassword('owner', 'pw', 'Owner', { role: 'owner', status: 'active' });
    member = deps.accounts.createPassword('mem', 'pw', 'Mem', { status: 'active' });
    const store = new ChatStore(path.join(dir, 'chat'));
    store.listChannels();
    sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, undefined, deps);
    await sm.start();
    ownerWs = await connect();
    memberWs = await connect();
    const ownerToken = deps.sessions.issue(owner.id).token;
    memberToken = deps.sessions.issue(member.id).token;
    ownerWs.send(JSON.stringify({ t: 'auth', token: ownerToken }));
    await nextFrame(ownerWs);
    memberWs.send(JSON.stringify({ t: 'auth', token: memberToken }));
    await nextFrame(memberWs);
  });
  afterEach(async () => {
    for (const c of clients) c.terminate();
    clients = [];
    if (sm) await sm.stop();
    sm = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function connect(): Promise<WebSocket> {
    const c = new WebSocket(`ws://127.0.0.1:${sm!.addressPort()}`);
    await once(c, 'open');
    clients.push(c);
    return c;
  }
  async function noFrameWithin(ws: WebSocket, ms = 150): Promise<'frame' | 'timeout'> {
    return Promise.race([
      nextFrame(ws).then(() => 'frame' as const),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms)),
    ]);
  }

  it('owner: adminUsers → 전체 목록(AdminUserDto)', async () => {
    ownerWs.send(JSON.stringify({ t: 'adminUsers' }));
    const f = await nextFrame(ownerWs);
    expect(f.t).toBe('adminUsers');
    const ids = f.list.map((u: { id: string }) => u.id);
    expect(ids).toEqual(expect.arrayContaining([owner.id, member.id]));
    const memberDto = f.list.find((u: { id: string }) => u.id === member.id);
    expect(memberDto).toMatchObject({
      loginId: 'mem', displayName: 'Mem', role: 'member', status: 'active', sso: false,
    });
    expect(typeof memberDto.createdAt).toBe('string');
  });

  it('member의 admin 프레임은 무시(응답 없음)', async () => {
    memberWs.send(JSON.stringify({ t: 'adminUsers' }));
    expect(await noFrameWithin(memberWs)).toBe('timeout');
  });

  it('authDeps 미주입 시 admin 프레임도 무시', async () => {
    const store2 = new ChatStore(path.join(dir, 'chat-noauth'));
    store2.listChannels();
    const sm2 = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store2, { logger: noLog });
    await sm2.start();
    const c = new WebSocket(`ws://127.0.0.1:${sm2.addressPort()}`);
    await once(c, 'open');
    c.send(JSON.stringify({ t: 'adminUsers' }));
    expect(await noFrameWithin(c)).toBe('timeout');
    c.terminate();
    await sm2.stop();
  });

  it('adminApprove: pending→active + 목록 재전송', async () => {
    const pending = deps.accounts.createPassword('pend', 'pw', 'Pend'); // 기본 status=pending
    ownerWs.send(JSON.stringify({ t: 'adminApprove', id: pending.id }));
    const f = await nextFrame(ownerWs);
    expect(f.t).toBe('adminUsers');
    expect(f.list.find((u: { id: string }) => u.id === pending.id).status).toBe('active');
  });

  it('adminSuspend: active→suspended + 그 사용자 소켓 끊김 + 세션 무효', async () => {
    const closePromise = once(memberWs, 'close');
    ownerWs.send(JSON.stringify({ t: 'adminSuspend', id: member.id }));
    const f = await nextFrame(ownerWs);
    expect(f.t).toBe('adminUsers');
    expect(f.list.find((u: { id: string }) => u.id === member.id).status).toBe('suspended');
    await closePromise;
    expect(deps.sessions.resolve(memberToken)).toBeNull();
  });

  it('adminSuspend: owner 대상은 무시(자기 잠금 방지)', async () => {
    ownerWs.send(JSON.stringify({ t: 'adminSuspend', id: owner.id }));
    const f = await nextFrame(ownerWs);
    expect(f.t).toBe('adminUsers');
    expect(f.list.find((u: { id: string }) => u.id === owner.id).status).toBe('active');
  });

  it('adminRestore·adminResetPassword·adminForceLogout 동작', async () => {
    deps.accounts.setStatus(member.id, 'suspended');
    ownerWs.send(JSON.stringify({ t: 'adminRestore', id: member.id }));
    let f = await nextFrame(ownerWs);
    expect(f.list.find((u: { id: string }) => u.id === member.id).status).toBe('active');

    ownerWs.send(JSON.stringify({ t: 'adminResetPassword', id: member.id, password: 'newpw' }));
    f = await nextFrame(ownerWs);
    expect(f.t).toBe('adminUsers');
    expect(deps.accounts.verifyPassword('mem', 'newpw')).not.toBeNull();

    const closePromise = once(memberWs, 'close');
    ownerWs.send(JSON.stringify({ t: 'adminForceLogout', id: member.id }));
    f = await nextFrame(ownerWs);
    expect(f.t).toBe('adminUsers');
    await closePromise;
    expect(deps.sessions.resolve(memberToken)).toBeNull();
  });

  it('adminGetSettings/adminSetSettings: settings.load/save 위임', async () => {
    let current: AdminSettings = { serverName: 'orig' };
    const saveSpy = jest.fn((s: AdminSettings) => { current = s; });
    deps.settings = { load: () => current, save: saveSpy };

    ownerWs.send(JSON.stringify({ t: 'adminGetSettings' }));
    let f = await nextFrame(ownerWs);
    expect(f).toEqual({ t: 'adminSettings', settings: { serverName: 'orig' } });

    const next: AdminSettings = { serverName: 'new' };
    ownerWs.send(JSON.stringify({ t: 'adminSetSettings', settings: next }));
    f = await nextFrame(ownerWs);
    expect(saveSpy).toHaveBeenCalledWith(next);
    expect(f).toEqual({ t: 'adminSettings', settings: next });
  });

  describe('adminSetPermissions(Phase 16b)', () => {
    it('owner: adminSetPermissions로 member 권한 설정 → adminUsers에 반영', async () => {
      ownerWs.send(JSON.stringify({ t: 'adminSetPermissions', id: member.id, permissions: ['wiki.approve'] }));
      const f = await nextFrame(ownerWs);
      expect(f.t).toBe('adminUsers');
      const memberDto = f.list.find((u: { id: string }) => u.id === member.id);
      expect(memberDto.permissions).toEqual(['wiki.approve']);
    });

    it('member(비owner)의 adminSetPermissions는 무시(권한 미변경)', async () => {
      memberWs.send(JSON.stringify({ t: 'adminSetPermissions', id: member.id, permissions: ['wiki.approve'] }));
      expect(await noFrameWithin(memberWs)).toBe('timeout');
      expect(deps.accounts.get(member.id)?.permissions ?? []).toEqual([]);
    });

    it('알 수 없는 키는 저장 시 필터', async () => {
      ownerWs.send(JSON.stringify({ t: 'adminSetPermissions', id: member.id, permissions: ['wiki.approve', 'bogus'] }));
      const f = await nextFrame(ownerWs);
      const memberDto = f.list.find((u: { id: string }) => u.id === member.id);
      expect(memberDto.permissions).toEqual(['wiki.approve']);
    });
  });
});

function fakePage(slug: string, status: 'draft' | 'published' = 'published'): WikiPage {
  return { slug, frontmatter: { title: `T-${slug}`, category: 'cat', status, sources: [], created: '2026-01-01T00:00:00Z', updated: '2026-01-02T00:00:00Z' }, body: `body-${slug}` };
}
function fakeProposal(id: string, status: Proposal['status'] = 'pending'): Proposal {
  return { id, userId: 'default', createdTs: '2026-01-01T00:00:00Z', op: 'create', targetSlug: `s-${id}`, title: `t-${id}`, category: 'cat', payload: `payload-${id}`, sources: ['src1'], importance: 3, verdict: { confidence: 0.8, reason: `why-${id}` }, status };
}

describe('SelfMessenger 위키·승인함', () => {
  let dir: string; let store: ChatStore; let sm: SelfMessenger; let client: WebSocket;
  let pages: WikiPage[]; let proposals: Proposal[]; let applied: string[]; let rejected: string[];
  let unpublished: string[]; let edited: { slug: string; body: string }[]; let deleted: string[];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-wiki-'));
    store = new ChatStore(dir); store.listChannels();
    pages = [fakePage('alpha'), fakePage('beta', 'draft')];
    proposals = [fakeProposal('p1'), fakeProposal('p2')];
    applied = []; rejected = [];
    unpublished = []; edited = []; deleted = [];
    const wikiDeps = {
      wiki: {
        listPages: async () => pages,
        getPage: async (slug: string) => pages.find((p) => p.slug === slug) ?? null,
        unpublishPage: async (slug: string) => { unpublished.push(slug); return {} as WikiPage; },
        editPage: async (slug: string, body: string) => { edited.push({ slug, body }); return {} as WikiPage; },
        deletePage: async (slug: string) => { deleted.push(slug); return true; },
        search: async (query: string) => (query === 'coffee' ? [{ slug: 'a', title: 'Alpha', text: 'matched snippet', score: 0.9 }] : []),
      },
      proposals: {
        listPending: async () => proposals.filter((p) => p.status === 'pending'),
        get: async (id: string) => proposals.find((p) => p.id === id) ?? null,
      },
      applier: {
        apply: async (p: Proposal) => { applied.push(p.id); },
        reject: async (p: Proposal) => { rejected.push(p.id); },
      },
    };
    sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, wikiDeps as any);
    await sm.start();
    client = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(client, 'open');
  });
  afterEach(async () => { client.terminate(); await sm.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('wikiList → 페이지 메타 목록', async () => {
    client.send(JSON.stringify({ t: 'wikiList' }));
    const f = await nextFrame(client);
    expect(f.t).toBe('wikiPages');
    expect(f.list).toEqual([
      { slug: 'alpha', title: 'T-alpha', category: 'cat', status: 'published', updated: '2026-01-02T00:00:00Z' },
      { slug: 'beta', title: 'T-beta', category: 'cat', status: 'draft', updated: '2026-01-02T00:00:00Z' },
    ]);
  });

  it('wikiGet → 페이지 전체(body 포함), 없으면 error', async () => {
    client.send(JSON.stringify({ t: 'wikiGet', slug: 'alpha' }));
    const f = await nextFrame(client);
    expect(f.t).toBe('wikiPage');
    expect(f.page).toMatchObject({ slug: 'alpha', body: 'body-alpha', status: 'published' });
    client.send(JSON.stringify({ t: 'wikiGet', slug: 'nope' }));
    const e = await nextFrame(client);
    expect(e.t).toBe('error');
  });

  it('proposalsList → pending 제안 DTO', async () => {
    client.send(JSON.stringify({ t: 'proposalsList' }));
    const f = await nextFrame(client);
    expect(f.t).toBe('proposals');
    expect(f.list).toHaveLength(2);
    expect(f.list[0]).toMatchObject({ id: 'p1', op: 'create', targetSlug: 's-p1', payload: 'payload-p1', confidence: 0.8, reason: 'why-p1', importance: 3 });
  });

  it('proposalApprove → applier.apply + wikiChanged·proposalsChanged 브로드캐스트', async () => {
    const got: string[] = [];
    client.on('message', (d) => got.push(JSON.parse(String(d)).t));
    client.send(JSON.stringify({ t: 'proposalApprove', id: 'p1' }));
    await new Promise((r) => setTimeout(r, 50)); // 두 프레임 도착 대기(실시간, 결정적)
    expect(applied).toEqual(['p1']);
    expect(got.sort()).toEqual(['proposalsChanged', 'wikiChanged']);
  });

  it('같은 제안 동시 승인은 한 번만 반영(중복 방지)', async () => {
    client.send(JSON.stringify({ t: 'proposalApprove', id: 'p1' }));
    client.send(JSON.stringify({ t: 'proposalApprove', id: 'p1' }));
    await new Promise((r) => setTimeout(r, 60));
    expect(applied).toEqual(['p1']); // 두 번이 아니라 한 번
  });

  it('proposalReject → applier.reject + proposalsChanged', async () => {
    client.send(JSON.stringify({ t: 'proposalReject', id: 'p2' }));
    const f = await nextFrame(client);
    expect(rejected).toEqual(['p2']);
    expect(f.t).toBe('proposalsChanged');
  });

  it('없는/처리된 제안 승인은 조용히 무시(applier 미호출)', async () => {
    proposals.push(fakeProposal('done', 'approved'));
    client.send(JSON.stringify({ t: 'proposalApprove', id: 'done' }));
    client.send(JSON.stringify({ t: 'wikiList' })); // 뒤에 온 프레임이 처리되면 앞은 무시된 것
    const f = await nextFrame(client);
    expect(f.t).toBe('wikiPages');
    expect(applied).toEqual([]);
  });

  it('wikiUnpublish → unpublishPage 호출 + wikiChanged 브로드캐스트', async () => {
    const got: string[] = [];
    client.on('message', (d) => got.push(JSON.parse(String(d)).t));
    client.send(JSON.stringify({ t: 'wikiUnpublish', slug: 'alpha' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(unpublished).toEqual(['alpha']);
    expect(got).toContain('wikiChanged');
  });

  it('wikiEdit → editPage(slug, body) 호출 + wikiChanged', async () => {
    const got: string[] = [];
    client.on('message', (d) => got.push(JSON.parse(String(d)).t));
    client.send(JSON.stringify({ t: 'wikiEdit', slug: 'alpha', body: 'NEW' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(edited).toEqual([{ slug: 'alpha', body: 'NEW' }]);
    expect(got).toContain('wikiChanged');
  });

  it('wikiDelete → deletePage 호출 + wikiChanged', async () => {
    const got: string[] = [];
    client.on('message', (d) => got.push(JSON.parse(String(d)).t));
    client.send(JSON.stringify({ t: 'wikiDelete', slug: 'alpha' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(deleted).toEqual(['alpha']);
    expect(got).toContain('wikiChanged');
  });

  it('wikiSearch → wikiResults(query 에코 + text→snippet 매핑)', async () => {
    client.send(JSON.stringify({ t: 'wikiSearch', query: 'coffee' }));
    const f = await nextFrame(client);
    expect(f.t).toBe('wikiResults');
    expect(f.query).toBe('coffee');
    expect(f.list).toEqual([{ slug: 'a', title: 'Alpha', snippet: 'matched snippet', score: 0.9 }]);
  });

  it('wikiSearch 결과 없음 → 빈 list', async () => {
    client.send(JSON.stringify({ t: 'wikiSearch', query: 'nope' }));
    const f = await nextFrame(client);
    expect(f.t).toBe('wikiResults');
    expect(f.list).toEqual([]);
  });

  it('wikiDeps 미주입 시 wikiList는 무시(no-op) — 뒤이은 channels만 응답', async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-nowiki-'));
    const store2 = new ChatStore(dir2); store2.listChannels();
    const sm2 = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store2, { logger: noLog });
    await sm2.start();
    const client2 = new WebSocket(`ws://127.0.0.1:${sm2.addressPort()}`);
    await once(client2, 'open');
    client2.send(JSON.stringify({ t: 'wikiList' }));
    client2.send(JSON.stringify({ t: 'channels' })); // 뒤에 온 프레임이 처리되면 앞은 무시된 것
    const f = await nextFrame(client2);
    expect(f.t).toBe('channels');
    client2.terminate();
    await sm2.stop();
    fs.rmSync(dir2, { recursive: true, force: true });
  });
});

describe('권한 게이트(Phase 16b)', () => {
  let dir: string;
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function noFrameWithin(ws: WebSocket, ms = 150): Promise<'frame' | 'timeout'> {
    return Promise.race([
      nextFrame(ws).then(() => 'frame' as const),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms)),
    ]);
  }

  it('authOk가 자기 permissions를 실어 보냄', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-'));
    const deps = makeAuthDeps(dir);
    const acc = deps.accounts.createPassword('mem', 'pw', 'Mem', { status: 'active' });
    deps.accounts.setPermissions(acc.id, ['wiki.approve']);
    const store = new ChatStore(path.join(dir, 'chat'));
    store.listChannels();
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, undefined, deps);
    await sm.start();
    const c = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(c, 'open');
    const sess = deps.sessions.issue(acc.id);
    c.send(JSON.stringify({ t: 'auth', token: sess.token }));
    const f = await nextFrame(c);
    expect(f.t).toBe('authOk');
    expect(f.user.permissions).toEqual(['wiki.approve']);
    c.terminate();
    await sm.stop();
  });

  it('wiki.approve 없는 member의 proposalApprove는 무시(제안 그대로 pending)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-'));
    const deps = makeAuthDeps(dir);
    const acc = deps.accounts.createPassword('mem', 'pw', 'Mem', { status: 'active' });
    const store = new ChatStore(path.join(dir, 'chat'));
    store.listChannels();
    const applied: string[] = [];
    const proposal = fakeProposal('p1');
    const wikiDeps = {
      wiki: { listPages: async () => [], getPage: async () => null },
      proposals: { listPending: async () => [proposal], get: async (id: string) => (id === proposal.id ? proposal : null) },
      applier: { apply: async (p: Proposal) => { applied.push(p.id); }, reject: async () => {} },
    };
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, wikiDeps as any, deps);
    await sm.start();
    const c = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(c, 'open');
    const sess = deps.sessions.issue(acc.id);
    c.send(JSON.stringify({ t: 'auth', token: sess.token }));
    await nextFrame(c); // authOk
    c.send(JSON.stringify({ t: 'proposalApprove', id: proposal.id }));
    expect(await noFrameWithin(c)).toBe('timeout');
    expect(applied).toEqual([]);
    expect(proposal.status).toBe('pending');
    c.terminate();
    await sm.stop();
  });

  it('wiki.approve 보유 member의 proposalApprove는 통과', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-'));
    const deps = makeAuthDeps(dir);
    const acc = deps.accounts.createPassword('mem', 'pw', 'Mem', { status: 'active' });
    deps.accounts.setPermissions(acc.id, ['wiki.approve']);
    const store = new ChatStore(path.join(dir, 'chat'));
    store.listChannels();
    const applied: string[] = [];
    const proposal = fakeProposal('p1');
    const wikiDeps = {
      wiki: { listPages: async () => [], getPage: async () => null },
      proposals: { listPending: async () => [proposal], get: async (id: string) => (id === proposal.id ? proposal : null) },
      applier: { apply: async (p: Proposal) => { applied.push(p.id); }, reject: async () => {} },
    };
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, wikiDeps as any, deps);
    await sm.start();
    const c = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(c, 'open');
    const sess = deps.sessions.issue(acc.id);
    c.send(JSON.stringify({ t: 'auth', token: sess.token }));
    await nextFrame(c); // authOk
    const got: string[] = [];
    c.on('message', (d) => got.push(JSON.parse(String(d)).t));
    c.send(JSON.stringify({ t: 'proposalApprove', id: proposal.id }));
    await new Promise((r) => setTimeout(r, 50));
    expect(applied).toEqual([proposal.id]);
    expect(got.sort()).toEqual(['proposalsChanged', 'wikiChanged']);
    c.terminate();
    await sm.stop();
  });

  it('권한 없는 member의 wikiDelete/wikiEdit/wikiUnpublish는 무시(메서드 미호출)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-'));
    const deps = makeAuthDeps(dir);
    const acc = deps.accounts.createPassword('mem', 'pw', 'Mem', { status: 'active' });
    const store = new ChatStore(path.join(dir, 'chat')); store.listChannels();
    const calls: string[] = [];
    const wikiDeps = {
      wiki: {
        listPages: async () => [], getPage: async () => null,
        unpublishPage: async () => { calls.push('unpublish'); return {} as WikiPage; },
        editPage: async () => { calls.push('edit'); return {} as WikiPage; },
        deletePage: async () => { calls.push('delete'); return true; },
      },
      proposals: { listPending: async () => [], get: async () => null },
      applier: { apply: async () => {}, reject: async () => {} },
    };
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, wikiDeps as never, deps);
    await sm.start();
    const c = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(c, 'open');
    const sess = deps.sessions.issue(acc.id);
    c.send(JSON.stringify({ t: 'auth', token: sess.token }));
    await nextFrame(c); // authOk
    c.send(JSON.stringify({ t: 'wikiDelete', slug: 'x' }));
    c.send(JSON.stringify({ t: 'wikiEdit', slug: 'x', body: 'y' }));
    c.send(JSON.stringify({ t: 'wikiUnpublish', slug: 'x' }));
    expect(await noFrameWithin(c)).toBe('timeout');
    expect(calls).toEqual([]);
    c.terminate(); await sm.stop();
  });

  it('권한 보유 member의 wikiDelete는 통과(deletePage 호출 + wikiChanged)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-'));
    const deps = makeAuthDeps(dir);
    const acc = deps.accounts.createPassword('mem', 'pw', 'Mem', { status: 'active' });
    deps.accounts.setPermissions(acc.id, ['wiki.delete']);
    const store = new ChatStore(path.join(dir, 'chat')); store.listChannels();
    const calls: string[] = [];
    const wikiDeps = {
      wiki: {
        listPages: async () => [], getPage: async () => null,
        unpublishPage: async () => ({} as WikiPage),
        editPage: async () => ({} as WikiPage),
        deletePage: async () => { calls.push('delete'); return true; },
      },
      proposals: { listPending: async () => [], get: async () => null },
      applier: { apply: async () => {}, reject: async () => {} },
    };
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, wikiDeps as never, deps);
    await sm.start();
    const c = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(c, 'open');
    const sess = deps.sessions.issue(acc.id);
    c.send(JSON.stringify({ t: 'auth', token: sess.token }));
    await nextFrame(c); // authOk
    const got: string[] = [];
    c.on('message', (d) => got.push(JSON.parse(String(d)).t));
    c.send(JSON.stringify({ t: 'wikiDelete', slug: 'x' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual(['delete']);
    expect(got).toContain('wikiChanged');
    c.terminate(); await sm.stop();
  });

  it('내가 만든 채널은 channels.manage 없이도 삭제 가능', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-'));
    const deps = makeAuthDeps(dir);
    const acc = deps.accounts.createPassword('mem', 'pw', 'Mem', { status: 'active' });
    const store = new ChatStore(path.join(dir, 'chat'));
    store.listChannels();
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, undefined, deps);
    await sm.start();
    const c = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(c, 'open');
    const sess = deps.sessions.issue(acc.id);
    c.send(JSON.stringify({ t: 'auth', token: sess.token }));
    await nextFrame(c); // authOk
    c.send(JSON.stringify({ t: 'createChannel', name: 'mine' }));
    const f1 = await nextFrame(c);
    const ch = f1.list.find((x: { name: string }) => x.name === 'mine');
    expect(ch).toBeDefined();
    c.send(JSON.stringify({ t: 'deleteChannel', id: ch.id }));
    const f2 = await nextFrame(c);
    expect(f2.list.find((x: { id: string }) => x.id === ch.id)).toBeUndefined();
    c.terminate();
    await sm.stop();
  });

  it('남이 만든 채널은 channels.manage 없으면 삭제 무시', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-'));
    const deps = makeAuthDeps(dir);
    const acc = deps.accounts.createPassword('mem', 'pw', 'Mem', { status: 'active' });
    const store = new ChatStore(path.join(dir, 'chat'));
    const ch = store.createChannel('theirs', 'chat', 'other')!;
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, undefined, deps);
    await sm.start();
    const c = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(c, 'open');
    const sess = deps.sessions.issue(acc.id);
    c.send(JSON.stringify({ t: 'auth', token: sess.token }));
    await nextFrame(c); // authOk
    c.send(JSON.stringify({ t: 'deleteChannel', id: ch.id }));
    const f = await nextFrame(c);
    expect(f.list.find((x: { id: string }) => x.id === ch.id)).toBeDefined();
    c.terminate();
    await sm.stop();
  });

  it('channels.manage 보유 member는 남 채널도 삭제 가능', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-'));
    const deps = makeAuthDeps(dir);
    const acc = deps.accounts.createPassword('mem', 'pw', 'Mem', { status: 'active' });
    deps.accounts.setPermissions(acc.id, ['channels.manage']);
    const store = new ChatStore(path.join(dir, 'chat'));
    const ch = store.createChannel('theirs', 'chat', 'other')!;
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, undefined, deps);
    await sm.start();
    const c = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(c, 'open');
    const sess = deps.sessions.issue(acc.id);
    c.send(JSON.stringify({ t: 'auth', token: sess.token }));
    await nextFrame(c); // authOk
    c.send(JSON.stringify({ t: 'deleteChannel', id: ch.id }));
    const f = await nextFrame(c);
    expect(f.list.find((x: { id: string }) => x.id === ch.id)).toBeUndefined();
    c.terminate();
    await sm.stop();
  });

  it('무인증 모드(authDeps 없음)는 전부 통과(회귀)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-'));
    const store = new ChatStore(path.join(dir, 'chat'));
    const ch = store.createChannel('theirs', 'chat', 'other')!;
    const applied: string[] = [];
    const proposal = fakeProposal('p1');
    const wikiDeps = {
      wiki: { listPages: async () => [], getPage: async () => null },
      proposals: { listPending: async () => [proposal], get: async (id: string) => (id === proposal.id ? proposal : null) },
      applier: { apply: async (p: Proposal) => { applied.push(p.id); }, reject: async () => {} },
    };
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, wikiDeps as any);
    await sm.start();
    const c = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(c, 'open');
    c.send(JSON.stringify({ t: 'deleteChannel', id: ch.id }));
    const f = await nextFrame(c);
    expect(f.list.find((x: { id: string }) => x.id === ch.id)).toBeUndefined();
    c.send(JSON.stringify({ t: 'proposalApprove', id: proposal.id }));
    await new Promise((r) => setTimeout(r, 50));
    expect(applied).toEqual([proposal.id]);
    c.terminate();
    await sm.stop();
  });
});

describe('비공개 채널 목록 필터(Phase 16c)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('비멤버는 channels에서 비공개 채널을 못 봄, 주인/멤버는 봄', async () => {
    const deps = makeAuthDeps(dir);
    const owner = deps.accounts.createPassword('owner', 'pw', 'Owner', { role: 'owner', status: 'active' });
    const memberA = deps.accounts.createPassword('a', 'pw', 'A', { status: 'active' });
    const memberB = deps.accounts.createPassword('b', 'pw', 'B', { status: 'active' });
    const memberC = deps.accounts.createPassword('c', 'pw', 'C', { status: 'active' });
    const store = new ChatStore(path.join(dir, 'chat'));
    store.listChannels(); // general(public) 생성
    const ch = store.createChannel('secret', 'chat', memberA.id, 'private')!;
    store.setMembers(ch.id, [memberB.id]);
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, undefined, deps);
    await sm.start();

    async function connectAs(acc: Account): Promise<WebSocket> {
      const c = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
      await once(c, 'open');
      c.send(JSON.stringify({ t: 'auth', token: deps.sessions.issue(acc.id).token }));
      await nextFrame(c); // authOk
      return c;
    }
    async function names(ws: WebSocket): Promise<string[]> {
      ws.send(JSON.stringify({ t: 'channels' }));
      const f = await nextFrame(ws);
      return f.list.map((x: { name: string }) => x.name);
    }

    const ownerWs = await connectAs(owner);
    const aWs = await connectAs(memberA);
    const bWs = await connectAs(memberB);
    const cWs = await connectAs(memberC);

    expect(await names(aWs)).toContain('secret');   // 주인
    expect(await names(bWs)).toContain('secret');   // 초대된 멤버
    expect(await names(ownerWs)).not.toContain('secret'); // owner라도 멤버 아니면 못 봄(감시 방지)
    expect(await names(cWs)).not.toContain('secret');     // 비멤버

    for (const c of [ownerWs, aWs, bWs, cWs]) c.terminate();
    await sm.stop();
  });

  it('공개 채널은 전원이 봄(회귀)', async () => {
    const deps = makeAuthDeps(dir);
    const memberA = deps.accounts.createPassword('a', 'pw', 'A', { status: 'active' });
    const memberB = deps.accounts.createPassword('b', 'pw', 'B', { status: 'active' });
    const store = new ChatStore(path.join(dir, 'chat'));
    store.listChannels(); // general(public) 생성
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, undefined, deps);
    await sm.start();

    async function connectAs(acc: Account): Promise<WebSocket> {
      const c = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
      await once(c, 'open');
      c.send(JSON.stringify({ t: 'auth', token: deps.sessions.issue(acc.id).token }));
      await nextFrame(c);
      return c;
    }

    const aWs = await connectAs(memberA);
    const bWs = await connectAs(memberB);
    aWs.send(JSON.stringify({ t: 'channels' }));
    const fa = await nextFrame(aWs);
    bWs.send(JSON.stringify({ t: 'channels' }));
    const fb = await nextFrame(bWs);
    expect(fa.list.map((x: { name: string }) => x.name)).toContain('general');
    expect(fb.list.map((x: { name: string }) => x.name)).toContain('general');

    aWs.terminate(); bWs.terminate();
    await sm.stop();
  });

  it('무인증 모드는 비공개 채널도 전부 보임(회귀)', async () => {
    const store = new ChatStore(path.join(dir, 'chat'));
    store.listChannels();
    store.createChannel('secret', 'chat', 'someone', 'private');
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog });
    await sm.start();
    const c = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(c, 'open');
    c.send(JSON.stringify({ t: 'channels' }));
    const f = await nextFrame(c);
    expect(f.list.map((x: { name: string }) => x.name)).toContain('secret');
    c.terminate();
    await sm.stop();
  });

  it('createChannel visibility=private로 만들면 주인만 보임', async () => {
    const deps = makeAuthDeps(dir);
    const memberA = deps.accounts.createPassword('a', 'pw', 'A', { status: 'active' });
    const memberB = deps.accounts.createPassword('b', 'pw', 'B', { status: 'active' });
    const store = new ChatStore(path.join(dir, 'chat'));
    store.listChannels();
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, undefined, deps);
    await sm.start();

    const aWs = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(aWs, 'open');
    const bWs = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(bWs, 'open');
    aWs.send(JSON.stringify({ t: 'auth', token: deps.sessions.issue(memberA.id).token }));
    await nextFrame(aWs); // authOk
    bWs.send(JSON.stringify({ t: 'auth', token: deps.sessions.issue(memberB.id).token }));
    await nextFrame(bWs); // authOk

    const bFramePromise = nextFrame(bWs); // createChannel의 broadcastChannels 대기
    aWs.send(JSON.stringify({ t: 'createChannel', name: 'p', visibility: 'private' }));
    const aFrame = await nextFrame(aWs);
    expect(aFrame.t).toBe('channels');
    expect(aFrame.list.map((c: { name: string }) => c.name)).toContain('p'); // 주인 소켓엔 보임

    const bFrame = await bFramePromise;
    expect(bFrame.t).toBe('channels');
    expect(bFrame.list.map((c: { name: string }) => c.name)).not.toContain('p'); // 다른 멤버엔 안 보임

    aWs.terminate(); bWs.terminate();
    await sm.stop();
  });
});

describe('비공개 채널 메시지 접근(Phase 16c)', () => {
  let dir: string;
  let clients: WebSocket[];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvmsg-'));
    clients = [];
  });
  afterEach(() => {
    for (const c of clients) c.terminate();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function noFrameWithin(ws: WebSocket, ms = 150): Promise<'frame' | 'timeout'> {
    return Promise.race([
      nextFrame(ws).then(() => 'frame' as const),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms)),
    ]);
  }

  it('비멤버 send는 무시(메시지 미기록·브로드캐스트 없음)', async () => {
    const deps = makeAuthDeps(dir);
    const memberA = deps.accounts.createPassword('a', 'pw', 'A', { status: 'active' });
    const memberC = deps.accounts.createPassword('c', 'pw', 'C', { status: 'active' });
    const store = new ChatStore(path.join(dir, 'chat'));
    store.listChannels();
    const ch = store.createChannel('secret', 'chat', memberA.id, 'private')!;
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, undefined, deps);
    await sm.start();

    const cWs = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    clients.push(cWs);
    await once(cWs, 'open');
    cWs.send(JSON.stringify({ t: 'auth', token: deps.sessions.issue(memberC.id).token }));
    await nextFrame(cWs); // authOk

    cWs.send(JSON.stringify({ t: 'send', channelId: ch.id, text: '몰래 들어옴' }));
    expect(await noFrameWithin(cWs)).toBe('timeout');
    expect(store.history(ch.id)).toHaveLength(0);

    await sm.stop();
  });

  it('비멤버 history는 빈 목록', async () => {
    const deps = makeAuthDeps(dir);
    const memberA = deps.accounts.createPassword('a', 'pw', 'A', { status: 'active' });
    const memberC = deps.accounts.createPassword('c', 'pw', 'C', { status: 'active' });
    const store = new ChatStore(path.join(dir, 'chat'));
    store.listChannels();
    const ch = store.createChannel('secret', 'chat', memberA.id, 'private')!;
    store.appendMessage(ch.id, { authorId: memberA.id, text: '비밀 메시지' });
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, undefined, deps);
    await sm.start();

    const cWs = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    clients.push(cWs);
    await once(cWs, 'open');
    cWs.send(JSON.stringify({ t: 'auth', token: deps.sessions.issue(memberC.id).token }));
    await nextFrame(cWs); // authOk

    cWs.send(JSON.stringify({ t: 'history', channelId: ch.id }));
    const f = await nextFrame(cWs);
    expect(f).toEqual({ t: 'history', channelId: ch.id, messages: [] });

    await sm.stop();
  });

  it('비공개 채널 msg는 접근자에게만 브로드캐스트', async () => {
    const deps = makeAuthDeps(dir);
    const memberA = deps.accounts.createPassword('a', 'pw', 'A', { status: 'active' });
    const memberB = deps.accounts.createPassword('b', 'pw', 'B', { status: 'active' });
    const owner = deps.accounts.createPassword('owner', 'pw', 'Owner', { role: 'owner', status: 'active' });
    const store = new ChatStore(path.join(dir, 'chat'));
    store.listChannels();
    const ch = store.createChannel('secret', 'chat', memberA.id, 'private')!;
    store.setMembers(ch.id, [memberB.id]);
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, undefined, deps);
    await sm.start();

    async function connectAs(acc: Account): Promise<WebSocket> {
      const c = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
      clients.push(c);
      await once(c, 'open');
      c.send(JSON.stringify({ t: 'auth', token: deps.sessions.issue(acc.id).token }));
      await nextFrame(c); // authOk
      return c;
    }

    const aWs = await connectAs(memberA);
    const bWs = await connectAs(memberB);
    const ownerWs = await connectAs(owner); // 비멤버(감시 방지 — owner라도 못 봄)

    const bFramePromise = nextFrame(bWs);
    const ownerNoFramePromise = noFrameWithin(ownerWs);
    aWs.send(JSON.stringify({ t: 'send', channelId: ch.id, text: '멤버만' }));
    const aFrame = await nextFrame(aWs);
    expect(aFrame.t).toBe('msg');
    expect(aFrame.message.text).toBe('멤버만');

    const bFrame = await bFramePromise;
    expect(bFrame.t).toBe('msg');
    expect(bFrame.message.text).toBe('멤버만');

    expect(await ownerNoFramePromise).toBe('timeout');

    await sm.stop();
  });

  it('공개 채널 msg는 전원(회귀)', async () => {
    const deps = makeAuthDeps(dir);
    const memberA = deps.accounts.createPassword('a', 'pw', 'A', { status: 'active' });
    const memberB = deps.accounts.createPassword('b', 'pw', 'B', { status: 'active' });
    const store = new ChatStore(path.join(dir, 'chat'));
    store.listChannels(); // general(public)
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, undefined, deps);
    await sm.start();

    async function connectAs(acc: Account): Promise<WebSocket> {
      const c = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
      clients.push(c);
      await once(c, 'open');
      c.send(JSON.stringify({ t: 'auth', token: deps.sessions.issue(acc.id).token }));
      await nextFrame(c); // authOk
      return c;
    }

    const aWs = await connectAs(memberA);
    const bWs = await connectAs(memberB);

    const bFramePromise = nextFrame(bWs);
    aWs.send(JSON.stringify({ t: 'send', channelId: 'general', text: '전원에게' }));
    const aFrame = await nextFrame(aWs);
    expect(aFrame.t).toBe('msg');
    const bFrame = await bFramePromise;
    expect(bFrame.t).toBe('msg');
    expect(bFrame.message.text).toBe('전원에게');

    await sm.stop();
  });

  it('무인증 모드는 send/history 정상(회귀)', async () => {
    const store = new ChatStore(path.join(dir, 'chat'));
    store.listChannels();
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog });
    await sm.start();
    const c = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    clients.push(c);
    await once(c, 'open');

    c.send(JSON.stringify({ t: 'send', channelId: 'general', text: 'hi' }));
    const f = await nextFrame(c);
    expect(f.t).toBe('msg');
    expect(f.message.text).toBe('hi');

    c.send(JSON.stringify({ t: 'history', channelId: 'general' }));
    const h = await nextFrame(c);
    expect(h.t).toBe('history');
    expect(h.messages.map((m: { text: string }) => m.text)).toEqual(['hi']);

    await sm.stop();
  });
});

describe('비공개 채널 멤버 관리(Phase 16c)', () => {
  let dir: string;
  let clients: WebSocket[];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-'));
    clients = [];
  });
  afterEach(() => {
    for (const c of clients) c.terminate();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function connectAs(sm: SelfMessenger, deps: AuthDeps, acc: Account): Promise<WebSocket> {
    const c = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    clients.push(c);
    await once(c, 'open');
    c.send(JSON.stringify({ t: 'auth', token: deps.sessions.issue(acc.id).token }));
    await nextFrame(c); // authOk
    return c;
  }

  it('주인은 setChannelMembers로 멤버 추가 → 추가된 멤버가 채널을 보게 됨', async () => {
    const deps = makeAuthDeps(dir);
    const memberA = deps.accounts.createPassword('a', 'pw', 'A', { status: 'active' });
    const memberB = deps.accounts.createPassword('b', 'pw', 'B', { status: 'active' });
    const store = new ChatStore(path.join(dir, 'chat'));
    store.listChannels();
    const ch = store.createChannel('secret', 'chat', memberA.id, 'private')!;
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, undefined, deps);
    await sm.start();

    const aWs = await connectAs(sm, deps, memberA);
    const bWs = await connectAs(sm, deps, memberB);

    bWs.send(JSON.stringify({ t: 'channels' }));
    const before = await nextFrame(bWs);
    expect(before.list.map((c: { name: string }) => c.name)).not.toContain('secret');

    const bFramePromise = nextFrame(bWs); // A의 setChannelMembers가 트리거한 broadcastChannels 대기
    aWs.send(JSON.stringify({ t: 'setChannelMembers', id: ch.id, memberIds: [memberB.id] }));
    await nextFrame(aWs); // A 자신의 broadcastChannels 결과

    const bFrame = await bFramePromise;
    expect(bFrame.t).toBe('channels');
    expect(bFrame.list.map((c: { name: string }) => c.name)).toContain('secret');

    await sm.stop();
  });

  it('비주인(멤버·channels.manage·owner)의 setChannelMembers/setChannelVisibility는 비공개 채널에 무시', async () => {
    const deps = makeAuthDeps(dir);
    const creator = deps.accounts.createPassword('creator', 'pw', 'Creator', { status: 'active' });
    const memberB = deps.accounts.createPassword('b', 'pw', 'B', { status: 'active' });
    const owner = deps.accounts.createPassword('owner', 'pw', 'Owner', { role: 'owner', status: 'active' });
    const mgr = deps.accounts.createPassword('mgr', 'pw', 'Mgr', { status: 'active' });
    deps.accounts.setPermissions(mgr.id, ['channels.manage']);
    const store = new ChatStore(path.join(dir, 'chat'));
    store.listChannels();
    const ch = store.createChannel('secret', 'chat', creator.id, 'private')!;
    store.setMembers(ch.id, [memberB.id]);
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, undefined, deps);
    await sm.start();

    for (const actor of [memberB, owner, mgr]) {
      const ws = await connectAs(sm, deps, actor);
      ws.send(JSON.stringify({ t: 'setChannelMembers', id: ch.id, memberIds: [] }));
      await nextFrame(ws); // broadcastChannels 결과(변경 없음이어도 프레임은 옴)
      ws.send(JSON.stringify({ t: 'setChannelVisibility', id: ch.id, visibility: 'public' }));
      await nextFrame(ws);
    }

    const stored = store.listChannels().find((c) => c.id === ch.id)!;
    expect(stored.memberIds).toEqual([memberB.id]);
    expect(stored.visibility).toBe('private');

    await sm.stop();
  });

  it('비주인 owner의 deleteChannel은 비공개 채널에 무시(주인 전용, 최종리뷰)', async () => {
    const deps = makeAuthDeps(dir);
    const creator = deps.accounts.createPassword('creator', 'pw', 'Creator', { status: 'active' });
    const owner = deps.accounts.createPassword('owner', 'pw', 'Owner', { role: 'owner', status: 'active' });
    const store = new ChatStore(path.join(dir, 'chat'));
    store.listChannels();
    const ch = store.createChannel('secret', 'chat', creator.id, 'private')!;
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, undefined, deps);
    await sm.start();

    const ws = await connectAs(sm, deps, owner);
    ws.send(JSON.stringify({ t: 'deleteChannel', id: ch.id }));
    await nextFrame(ws); // broadcastChannels(변경 없음이어도 프레임은 옴)

    expect(store.listChannels().find((c) => c.id === ch.id)).toBeDefined();

    await sm.stop();
  });

  it('공개 채널 setChannelVisibility는 16b 관리자(creator/channels.manage/owner)가 가능', async () => {
    const deps = makeAuthDeps(dir);
    const mgr = deps.accounts.createPassword('mgr', 'pw', 'Mgr', { status: 'active' });
    deps.accounts.setPermissions(mgr.id, ['channels.manage']);
    const store = new ChatStore(path.join(dir, 'chat'));
    const ch = store.createChannel('pub', 'chat', 'someone-else')!; // 공개, mgr은 창설자가 아님
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, undefined, deps);
    await sm.start();

    const ws = await connectAs(sm, deps, mgr);
    ws.send(JSON.stringify({ t: 'setChannelVisibility', id: ch.id, visibility: 'private' }));
    await nextFrame(ws); // broadcastChannels

    const stored = store.listChannels().find((c) => c.id === ch.id)!;
    expect(stored.visibility).toBe('private');

    await sm.stop();
  });

  it('setChannelMembers는 존재하는 계정만 수용', async () => {
    const deps = makeAuthDeps(dir);
    const creator = deps.accounts.createPassword('creator', 'pw', 'Creator', { status: 'active' });
    const memberB = deps.accounts.createPassword('b', 'pw', 'B', { status: 'active' });
    const store = new ChatStore(path.join(dir, 'chat'));
    const ch = store.createChannel('secret', 'chat', creator.id, 'private')!;
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, undefined, deps);
    await sm.start();

    const ws = await connectAs(sm, deps, creator);
    ws.send(JSON.stringify({ t: 'setChannelMembers', id: ch.id, memberIds: [memberB.id, 'nope-does-not-exist'] }));
    await nextFrame(ws); // broadcastChannels

    const stored = store.listChannels().find((c) => c.id === ch.id)!;
    expect(stored.memberIds).toEqual([memberB.id]);

    await sm.stop();
  });

  it('channelRoster는 id+displayName만(민감정보 없음), active 계정만, 인증 사용자면 반환', async () => {
    const deps = makeAuthDeps(dir);
    const memberA = deps.accounts.createPassword('a', 'pw', 'A', { status: 'active' });
    const memberB = deps.accounts.createPassword('b', 'pw', 'B', { status: 'active' });
    deps.accounts.createPassword('p', 'pw', 'Pending'); // 기본 status=pending → roster 제외
    const store = new ChatStore(path.join(dir, 'chat'));
    store.listChannels();
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog }, undefined, deps);
    await sm.start();

    const ws = await connectAs(sm, deps, memberA);
    ws.send(JSON.stringify({ t: 'channelRoster' }));
    const f = await nextFrame(ws);
    expect(f.t).toBe('roster');
    const ids = f.list.map((r: { id: string }) => r.id).sort();
    expect(ids).toEqual([memberA.id, memberB.id].sort());
    for (const entry of f.list) {
      expect(Object.keys(entry).sort()).toEqual(['displayName', 'id']);
    }

    await sm.stop();
  });

  it('무인증 모드 channelRoster는 빈 목록', async () => {
    const store = new ChatStore(path.join(dir, 'chat'));
    store.listChannels();
    const sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog });
    await sm.start();
    const ws = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    clients.push(ws);
    await once(ws, 'open');

    ws.send(JSON.stringify({ t: 'channelRoster' }));
    const f = await nextFrame(ws);
    expect(f).toEqual({ t: 'roster', list: [] });

    await sm.stop();
  });
});

describe('/mcp HTTP 노출(Phase 8c-2)', () => {
  let dir: string;
  let store: ChatStore;
  let sm: SelfMessenger | undefined;

  function makeMcpDeps(overrides: Partial<McpDeps> = {}): McpDeps {
    return {
      search: jest.fn().mockResolvedValue([]),
      read: jest.fn().mockResolvedValue(null),
      list: jest.fn().mockResolvedValue([]),
      propose: jest.fn().mockResolvedValue('p1'),
      askBrain: null,
      brainNames: jest.fn().mockReturnValue([]),
      ...overrides,
    };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-mcp-'));
    store = new ChatStore(dir);
    store.listChannels();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (sm) await sm.stop();
    sm = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('mcpDeps 주입 + 루프백 → initialize/tools 왕복 성공', async () => {
    sm = new SelfMessenger(
      { enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog },
      undefined, undefined, makeMcpDeps(),
    );
    await sm.start();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${sm.addressPort()}/mcp`));
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['wiki_list', 'wiki_propose', 'wiki_read', 'wiki_search']);
    await client.close();
  });

  it('비루프백 원격 주소 → 403(isLoopback 모킹)', async () => {
    jest.spyOn(mcpHttp, 'isLoopback').mockReturnValue(false);
    sm = new SelfMessenger(
      { enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog },
      undefined, undefined, makeMcpDeps(),
    );
    await sm.start();
    const res = await fetch(`http://127.0.0.1:${sm.addressPort()}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }),
    });
    expect(res.status).toBe(403);
  });

  it('mcpDeps 미주입 → 404(기존 라우팅과 동일)', async () => {
    sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog });
    await sm.start();
    const res = await fetch(`http://127.0.0.1:${sm.addressPort()}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }),
    });
    expect(res.status).toBe(404);
  });

  it('동시 POST 2건(별도 소켓·한쪽 200ms 지연) → 둘 다 성공(요청별 Server 생성 회귀)', async () => {
    // 리뷰 적발 경합: Server 싱글턴 공유 시 첫 요청이 in-flight인 동안 두 번째 connect()가
    // "Already connected" throw → 500. 요청별 buildMcpServer로 고쳐진 것을 실 어댑터에서 고정.
    const deps = makeMcpDeps({
      search: jest.fn().mockImplementation(async (query: string) => {
        if (query === 'slow') {
          await new Promise((r) => setTimeout(r, 200));
          return [{ slug: 'slow', title: 'Slow', snippet: 's' }];
        }
        return [{ slug: 'fast', title: 'Fast', snippet: 'f' }];
      }),
    });
    sm = new SelfMessenger(
      { enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog },
      undefined, undefined, deps,
    );
    await sm.start();
    const url = `http://127.0.0.1:${sm.addressPort()}/mcp`;
    const a = new Client({ name: 'client-a', version: '1.0.0' });
    await a.connect(new StreamableHTTPClientTransport(new URL(url)));
    const b = new Client({ name: 'client-b', version: '1.0.0' });
    await b.connect(new StreamableHTTPClientTransport(new URL(url)));
    const [ra, rb] = await Promise.all([
      a.callTool({ name: 'wiki_search', arguments: { query: 'slow' } }),
      (async () => {
        await new Promise((r) => setTimeout(r, 50)); // slow가 확실히 in-flight인 시점에 겹치게
        return b.callTool({ name: 'wiki_search', arguments: { query: 'fast' } });
      })(),
    ]);
    expect(ra.isError).toBeFalsy();
    expect(rb.isError).toBeFalsy();
    expect(JSON.stringify(ra.content)).toContain('slow');
    expect(JSON.stringify(rb.content)).toContain('fast');
    await a.close();
    await b.close();
  });

  // Task 2(§3.4): wikiDeps 주입 시 앱 /mcp에도 승인 도구 3종 상시 노출 + ws 승인함과 같은
  // in-flight Set 공유(교차 경로 이중승인 차단) + 성공 시 ws 클라 실시간 브로드캐스트.
  function makeWikiDeps(proposal: Proposal, opts?: { applyDelayGate?: Promise<void>; applied?: string[] }) {
    return {
      wiki: { listPages: async () => [], getPage: async () => null },
      proposals: {
        listPending: async () => [proposal],
        get: async (id: string) => (id === proposal.id ? proposal : null),
      },
      applier: {
        apply: async (p: Proposal) => {
          if (opts?.applyDelayGate) await opts.applyDelayGate;
          opts?.applied?.push(p.id);
        },
        reject: async () => {},
      },
    };
  }

  it('wikiDeps 주입 시 tools/list에 승인 도구 3종 포함', async () => {
    const proposal = fakeProposal('p1');
    sm = new SelfMessenger(
      { enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog },
      makeWikiDeps(proposal) as any, undefined, makeMcpDeps(),
    );
    await sm.start();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${sm.addressPort()}/mcp`)));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['list_proposals', 'approve_proposal', 'reject_proposal']));
    await client.close();
  });

  it('ws 승인함이 in-flight인 같은 id를 MCP approve → isError(ws와 같은 approving Set 공유 증거)', async () => {
    let resolveApply!: () => void;
    const applyDelayGate = new Promise<void>((r) => { resolveApply = r; });
    const applied: string[] = [];
    const proposal = fakeProposal('p1');
    sm = new SelfMessenger(
      { enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog },
      makeWikiDeps(proposal, { applyDelayGate, applied }) as any, undefined, makeMcpDeps(),
    );
    await sm.start();
    const ws = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(ws, 'open');
    ws.send(JSON.stringify({ t: 'proposalApprove', id: proposal.id }));
    // ws 핸들러가 approving.add(id)를 동기 실행한 뒤 applier.apply(비동기·게이트로 정지)로 들어간
    // 시점을 기다린다 — 그 뒤 MCP approve가 같은 id를 보면 in-flight로 거부돼야 Set 공유가 증명된다.
    await new Promise((r) => setTimeout(r, 30));
    const client = new Client({ name: 'race-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${sm.addressPort()}/mcp`)));
    const res = await client.callTool({ name: 'approve_proposal', arguments: { id: proposal.id } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('already being approved');
    resolveApply();
    await new Promise((r) => setTimeout(r, 30)); // ws쪽 apply 완료 대기(정리)
    expect(applied).toEqual([proposal.id]); // ws 경로가 결국 1회만 반영
    await client.close();
    ws.terminate();
  });

  it('MCP approve 성공 → 연결된 ws 클라에 wikiChanged+proposalsChanged 브로드캐스트', async () => {
    const applied: string[] = [];
    const proposal = fakeProposal('p1');
    sm = new SelfMessenger(
      { enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog },
      makeWikiDeps(proposal, { applied }) as any, undefined, makeMcpDeps(),
    );
    await sm.start();
    const ws = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(ws, 'open');
    const got: string[] = [];
    ws.on('message', (d) => got.push(JSON.parse(String(d)).t));

    const client = new Client({ name: 'broadcast-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${sm.addressPort()}/mcp`)));
    const res = await client.callTool({ name: 'approve_proposal', arguments: { id: proposal.id } });
    expect(res.isError).toBeFalsy();
    expect(applied).toEqual([proposal.id]);
    await new Promise((r) => setTimeout(r, 50));
    expect(got.sort()).toEqual(['proposalsChanged', 'wikiChanged']);
    await client.close();
    ws.terminate();
  });
});

describe('/admin HTTP 노출(Task 2, 서버 콘솔 S1)', () => {
  let dir: string; let distDir: string;
  let store: ChatStore;
  let accounts: AccountStore; let sessions: SessionStore;
  let sm: SelfMessenger | undefined;

  function makeAdminDeps(): AdminDeps {
    const http = new AdminHttp({
      accounts, sessions, chat: store,
      wiki: { listPages: async () => [] } as any,
      proposals: { listPending: async () => [] } as any,
      distDir,
    });
    return { http };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-admin-'));
    store = new ChatStore(path.join(dir, 'chat'));
    store.listChannels();
    accounts = new AccountStore(dir);
    sessions = new SessionStore(dir);
    distDir = path.join(dir, 'consoledist');
    fs.mkdirSync(distDir);
    fs.writeFileSync(path.join(distDir, 'index.html'), '<html>admin</html>');
  });
  afterEach(async () => {
    if (sm) await sm.stop();
    sm = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('authDeps+adminDeps 둘 다 있으면 /admin이 콘솔 index.html을 서빙한다', async () => {
    sm = new SelfMessenger(
      { enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog },
      undefined, makeAuthDeps(dir), undefined, makeAdminDeps(),
    );
    await sm.start();
    const r = await fetch(`http://127.0.0.1:${sm.addressPort()}/admin`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('<html>admin</html>');
  });

  it('adminDeps 미주입(authDeps만) → /admin 404(기존 폴스루)', async () => {
    sm = new SelfMessenger(
      { enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog },
      undefined, makeAuthDeps(dir),
    );
    await sm.start();
    const r = await fetch(`http://127.0.0.1:${sm.addressPort()}/admin`);
    expect(r.status).toBe(404);
  });

  it('authDeps 미주입(brain 모드·adminDeps만 있어도) → /admin 404', async () => {
    sm = new SelfMessenger(
      { enabled: true, port: 0, bind: '127.0.0.1', role: 'brain' } as any, store, { logger: noLog },
      undefined, undefined, undefined, makeAdminDeps(),
    );
    await sm.start();
    const r = await fetch(`http://127.0.0.1:${sm.addressPort()}/admin`);
    expect(r.status).toBe(404);
  });

  it('ENGRAM_DESKTOP=1이면 authDeps+adminDeps 둘 다 있어도 /admin 404(데스크톱 방어 이중화)', async () => {
    // 리뷰 지적: 콘솔은 서버 에디션 물건 — 데스크톱 상주 백엔드는 ENGRAM_DESKTOP='1'로 뜬다
    // (src/desktop/main.ts childEnv). main.ts가 이 값이면 애초에 adminDeps를 안 만들지만, 여기선
    // adminDeps를 일부러 주입한 채(=main.ts 배선이 잘못됐다고 가정) self.adapter 자체의 방어선을
    // 직접 검증한다 — 두 계층 중 하나만 있어도 데스크톱은 항상 404여야 한다.
    const ORIGINAL = process.env.ENGRAM_DESKTOP;
    process.env.ENGRAM_DESKTOP = '1';
    try {
      sm = new SelfMessenger(
        { enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog },
        undefined, makeAuthDeps(dir), undefined, makeAdminDeps(),
      );
      await sm.start();
      const r = await fetch(`http://127.0.0.1:${sm.addressPort()}/admin`);
      expect(r.status).toBe(404);
    } finally {
      if (ORIGINAL === undefined) delete process.env.ENGRAM_DESKTOP;
      else process.env.ENGRAM_DESKTOP = ORIGINAL;
    }
  });

  it('/admin/api/overview 전 구간 배선: owner 세션 → 200', async () => {
    const authDeps = makeAuthDeps(dir);
    const owner = authDeps.accounts.createPassword('boss', 'pw', 'Boss', { role: 'owner', status: 'active' });
    const token = authDeps.sessions.issue(owner.id).token;
    sm = new SelfMessenger(
      { enabled: true, port: 0, bind: '127.0.0.1', role: 'server' }, store, { logger: noLog },
      undefined, authDeps, undefined, makeAdminDeps(),
    );
    await sm.start();
    const r = await fetch(`http://127.0.0.1:${sm.addressPort()}/admin/api/overview`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { members: number };
    expect(body.members).toBe(1);
  });
});
