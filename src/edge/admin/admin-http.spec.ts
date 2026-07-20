import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AccountStore } from '../auth/account-store';
import { SessionStore } from '../auth/session-store';
import { GroupStore } from '../auth/group-store';
import { ChatStore } from '../messenger/chat-store';
import { AdminHttp, type AdminHttpDeps } from './admin-http';

describe('AdminHttp', () => {
  let dir: string; let distDir: string; let configDir: string;
  let accounts: AccountStore; let sessions: SessionStore; let chat: ChatStore; let groups: GroupStore;
  let wikiPages: unknown[]; let pending: unknown[];
  let server: http.Server; let base: string;

  function startServer(overrides: Partial<AdminHttpDeps> = {}) {
    const deps: AdminHttpDeps = {
      accounts, sessions, chat, groups,
      wiki: { listPages: async () => wikiPages } as any,
      proposals: { listPending: async () => pending } as any,
      distDir,
      configDir,
      ...overrides,
    };
    const admin = new AdminHttp(deps);
    server = http.createServer((req, res) => {
      void admin.handle(req, res).then((hit) => { if (!hit) { res.writeHead(404); res.end(); } });
    });
    return new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const a = server.address();
        base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
        resolve();
      });
    });
  }

  // fetch()(WHATWG URL)는 '..'·%2e%2e 같은 dot-segment를 클라에서 먼저 정규화해버려 서버에 그
  // 리터럴 문자열이 아예 안 닿는다(예: '/admin/%2e%2e/x'는 fetch가 이미 '/x'로 접어서 보낸다 —
  // 서버측 방어를 검증한 게 아니라 클라 정규화를 검증한 꼴). http.request는 path를 있는 그대로
  // 전송해 서버가 실제로 받는 raw url을 통제할 수 있다 — traversal 회귀 테스트는 이걸 쓴다.
  function rawGet(pathStr: string): Promise<{ status: number }> {
    const a = server.address();
    const port = typeof a === 'object' && a ? a.port : 0;
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: pathStr, method: 'GET' }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-http-'));
    accounts = new AccountStore(dir);
    sessions = new SessionStore(dir);
    groups = new GroupStore(dir);
    chat = new ChatStore(path.join(dir, 'chat'));
    chat.listChannels(); // general 채널 생성
    wikiPages = [{ slug: 'a' }, { slug: 'b' }];
    pending = [{ id: 'p1', title: 'Proposal One' }];

    configDir = path.join(dir, 'config'); // brains.json/mcp.json 위치(모델·MCP api, 서버 콘솔 S3 Task 1) — 헬퍼가 필요시 자동 생성
    distDir = path.join(dir, 'consoledist'); // dir의 하위 — traversal 테스트에서 dir을 "루트 밖"으로 쓴다
    fs.mkdirSync(distDir);
    fs.writeFileSync(path.join(distDir, 'index.html'), '<html>console</html>');
    fs.mkdirSync(path.join(distDir, 'assets'));
    fs.writeFileSync(path.join(distDir, 'assets', 'app.js'), 'console.log(1)');
    fs.writeFileSync(path.join(distDir, 'logo.png'), 'binary-ish');
  });

  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    fs.rmSync(dir, { recursive: true, force: true }); // distDir(dir 하위) 포함해 함께 정리
  });

  describe('정적 서빙', () => {
    it('①/admin → index.html(200, html)', async () => {
      await startServer();
      const r = await fetch(base + '/admin');
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/html');
      expect(await r.text()).toBe('<html>console</html>');
    });

    it('/admin/assets/app.js → js 콘텐츠 타입', async () => {
      await startServer();
      const r = await fetch(base + '/admin/assets/app.js');
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('application/javascript');
      expect(await r.text()).toBe('console.log(1)');
    });

    it('④SPA 폴백: 확장자 없는 미지 라우트 → index.html', async () => {
      await startServer();
      const r = await fetch(base + '/admin/members/pending');
      expect(r.status).toBe(200);
      expect(await r.text()).toBe('<html>console</html>');
    });

    it('②path traversal(encoded ..) → 404, 루트 밖 파일 유출 없음', async () => {
      // distDir의 부모(=dir)에 콘솔 dist 밖 파일을 둬서, 탈출이 성공하면 이 내용이 새어나온다.
      fs.writeFileSync(path.join(dir, 'secret.html'), 'OUTER SECRET');
      await startServer();
      const r = await fetch(base + '/admin/%2e%2e/secret.html');
      expect(r.status).toBe(404);
    });

    it('Minor 2-①: %5c(인코딩된 백슬래시) traversal → 404, 루트 밖 파일 유출 없음', async () => {
      // Windows에서 %5c는 디코드되면 '\\' — 슬래시 대신 백슬래시로 위장한 상위 이탈 시도.
      fs.writeFileSync(path.join(dir, 'secret.html'), 'OUTER SECRET');
      await startServer();
      const r = await rawGet('/admin/..%5c..%5csecret.html');
      expect(r.status).toBe(404);
    });

    it('Minor 2-②: 이중 선행 슬래시(UNC 모양) traversal → 404, 루트 밖 파일 유출 없음', async () => {
      // '//..//..//' 형태 — Windows path.normalize가 선행 '//'를 UNC 표식으로 보존해 뒤이은 '..'
      // collapse 결과가 일반 케이스와 달라질 수 있는 지점(정규화 방식과 무관하게 최종 위치로 방어).
      fs.writeFileSync(path.join(dir, 'secret.html'), 'OUTER SECRET');
      await startServer();
      const r = await rawGet('/admin//..//..//secret.html');
      expect(r.status).toBe(404);
    });

    it('화이트리스트 밖 확장자(.png)는 파일이 있어도 404', async () => {
      await startServer();
      const r = await fetch(base + '/admin/logo.png');
      expect(r.status).toBe(404);
    });

    it('존재하지 않는 자산(확장자 있음) → 404(SPA 폴백 없음)', async () => {
      await startServer();
      const r = await fetch(base + '/admin/assets/missing.js');
      expect(r.status).toBe(404);
    });

    it('/admin/ 밖 경로는 false(상위 라우터가 404 처리)', async () => {
      await startServer();
      const r = await fetch(base + '/other');
      expect(r.status).toBe(404);
    });
  });

  describe('overview API(owner 게이트)', () => {
    it('Minor 2-③(Minor 1 회귀): /admin/%61pi/overview(encoded a) → api 게이트로 라우팅(401, 정적 서빙 아님)', async () => {
      // 예전엔 api 접두 매칭이 raw url 기준이라 %61(='a')처럼 인코딩된 api 경로가 정적 서빙으로
      // 새서 404/index.html 폴백을 탔다 — decode-once 수정 후엔 정상적으로 overview 게이트(401)를 탄다.
      await startServer();
      const r = await rawGet('/admin/%61pi/overview');
      expect(r.status).toBe(401);
    });

    it('미설정 서버(계정 0) → 401(토큰 없어도 데이터 노출 금지)', async () => {
      await startServer();
      const r = await fetch(base + '/admin/api/overview');
      expect(r.status).toBe(401);
    });

    it('무토큰(계정 있음) → 401', async () => {
      accounts.createPassword('boss', 'pw', 'Boss', { role: 'owner', status: 'active' });
      await startServer();
      const r = await fetch(base + '/admin/api/overview');
      expect(r.status).toBe(401);
    });

    it('무효 토큰 → 401', async () => {
      accounts.createPassword('boss', 'pw', 'Boss', { role: 'owner', status: 'active' });
      await startServer();
      const r = await fetch(base + '/admin/api/overview', { headers: { authorization: 'Bearer nope' } });
      expect(r.status).toBe(401);
    });

    it('비owner(member) 세션 → 403', async () => {
      accounts.createPassword('boss', 'pw', 'Boss', { role: 'owner', status: 'active' });
      const member = accounts.createPassword('mem', 'pw', 'Mem', { role: 'member', status: 'active' });
      const tok = sessions.issue(member.id).token;
      await startServer();
      const r = await fetch(base + '/admin/api/overview', { headers: { authorization: `Bearer ${tok}` } });
      expect(r.status).toBe(403);
    });

    it('③owner 세션 → 200 + 실수치(+ 처리할 일 이름/제목 미리보기)', async () => {
      const owner = accounts.createPassword('boss', 'pw', 'Boss', { role: 'owner', status: 'active' });
      accounts.createPassword('pend', 'pw', 'Pend Name'); // 기본 status pending
      chat.createChannel('dev');
      chat.appendMessage('general', { authorId: owner.id, text: 'hi today' });
      chat.appendMessage('general', { authorId: owner.id, text: 'again today' });
      // 어제 메시지를 jsonl에 직접 삽입(오늘 카운트에서 제외돼야 함).
      const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      fs.appendFileSync(
        path.join(dir, 'chat', 'general.jsonl'),
        JSON.stringify({ id: 'y1', authorId: owner.id, text: 'yesterday', ts: yesterday }) + '\n',
      );
      const tok = sessions.issue(owner.id).token;
      await startServer();
      const r = await fetch(base + '/admin/api/overview', { headers: { authorization: `Bearer ${tok}` } });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({
        members: 1, // owner만 active(pend는 status pending)
        pendingMembers: 1,
        channels: 2, // general + dev
        wikiPages: 2,
        pendingProposals: 1,
        todayMessages: 2, // 어제 메시지 제외
        pendingMemberNames: ['Pend Name'],
        pendingProposalTitles: ['Proposal One'],
      });
    });

    it('처리할 일 미리보기는 최초 5개까지만(저비용 상한)', async () => {
      const owner = accounts.createPassword('boss', 'pw', 'Boss', { role: 'owner', status: 'active' });
      for (let i = 0; i < 7; i++) accounts.createPassword(`pend${i}`, 'pw', `Pend ${i}`);
      pending = Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, title: `Proposal ${i}` }));
      const tok = sessions.issue(owner.id).token;
      await startServer();
      const r = await fetch(base + '/admin/api/overview', { headers: { authorization: `Bearer ${tok}` } });
      const body = await r.json() as { pendingMembers: number; pendingMemberNames: string[]; pendingProposals: number; pendingProposalTitles: string[] };
      expect(body.pendingMembers).toBe(7);
      expect(body.pendingMemberNames).toHaveLength(5);
      expect(body.pendingProposals).toBe(7);
      expect(body.pendingProposalTitles).toHaveLength(5);
    });
  });

  // 멤버·그룹·채널 API 공통 헬퍼(서버 콘솔 S2 Task 2).
  function authFetch(pathStr: string, token: string | null, init: RequestInit = {}) {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (token) headers.authorization = `Bearer ${token}`;
    return fetch(base + pathStr, { ...init, headers });
  }
  function post(pathStr: string, token: string | null, body?: unknown) {
    return authFetch(pathStr, token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  function patch(pathStr: string, token: string | null, body?: unknown) {
    return authFetch(pathStr, token, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  function del(pathStr: string, token: string | null) {
    return authFetch(pathStr, token, { method: 'DELETE' });
  }

  describe('owner 게이트(멤버·그룹·채널 api 전체)', () => {
    // 브리프: 각 엔드포인트 owner 200·비owner 403·무토큰 401. 11개 엔드포인트를 표로 일괄 검증.
    const table: Array<{ label: string; call: () => Promise<Response> }> = [
      { label: 'GET members', call: () => authFetch('/admin/api/members', tokFor('owner')) },
      { label: 'POST members', call: () => post('/admin/api/members', tokFor('owner'), { loginId: 'gate1', displayName: 'Gate', password: 'pw' }) },
      { label: 'POST members/:id/status', call: () => post(`/admin/api/members/${idFor('member')}/status`, tokFor('owner'), { status: 'active' }) },
      { label: 'POST members/:id/permissions', call: () => post(`/admin/api/members/${idFor('member')}/permissions`, tokFor('owner'), { permissions: [] }) },
      { label: 'GET groups', call: () => authFetch('/admin/api/groups', tokFor('owner')) },
      { label: 'POST groups', call: () => post('/admin/api/groups', tokFor('owner'), { name: 'g' }) },
      { label: 'PATCH groups/:id', call: () => patch(`/admin/api/groups/${groupId}`, tokFor('owner'), { name: 'g2' }) },
      { label: 'DELETE groups/:id', call: () => del(`/admin/api/groups/${groupId}`, tokFor('owner')) },
      { label: 'GET channels', call: () => authFetch('/admin/api/channels', tokFor('owner')) },
      { label: 'POST channels/:id/visibility', call: () => post('/admin/api/channels/general/visibility', tokFor('owner'), { visibility: 'private' }) },
      { label: 'DELETE channels/:id', call: () => del('/admin/api/channels/general', tokFor('owner')) },
    ];
    let owner: ReturnType<AccountStore['createPassword']>;
    let member: ReturnType<AccountStore['createPassword']>;
    let groupId: string;
    function tokFor(who: 'owner' | 'member'): string { return sessions.issue(who === 'owner' ? owner.id : member.id).token; }
    function idFor(who: 'owner' | 'member'): string { return who === 'owner' ? owner.id : member.id; }

    beforeEach(async () => {
      owner = accounts.createPassword('boss', 'pw', 'Boss', { role: 'owner', status: 'active' });
      member = accounts.createPassword('mem', 'pw', 'Mem', { role: 'member', status: 'active' });
      groupId = groups.create('g0').id;
      await startServer();
    });

    for (const entry of [
      { label: 'GET members', mk: () => authFetch('/admin/api/members', null) },
      { label: 'POST members', mk: () => post('/admin/api/members', null, { loginId: 'x', displayName: 'x', password: 'x' }) },
      { label: 'POST members/:id/status', mk: () => post('/admin/api/members/nope/status', null, { status: 'active' }) },
      { label: 'POST members/:id/permissions', mk: () => post('/admin/api/members/nope/permissions', null, { permissions: [] }) },
      { label: 'GET groups', mk: () => authFetch('/admin/api/groups', null) },
      { label: 'POST groups', mk: () => post('/admin/api/groups', null, { name: 'g' }) },
      { label: 'PATCH groups/:id', mk: () => patch('/admin/api/groups/nope', null, { name: 'g' }) },
      { label: 'DELETE groups/:id', mk: () => del('/admin/api/groups/nope', null) },
      { label: 'GET channels', mk: () => authFetch('/admin/api/channels', null) },
      { label: 'POST channels/:id/visibility', mk: () => post('/admin/api/channels/general/visibility', null, { visibility: 'private' }) },
      { label: 'DELETE channels/:id', mk: () => del('/admin/api/channels/general', null) },
    ]) {
      it(`${entry.label}: 무토큰 → 401`, async () => {
        const r = await entry.mk();
        expect(r.status).toBe(401);
      });
    }

    it('비owner(member) 세션 → 403(대표 샘플: members/groups/channels 각 1개씩)', async () => {
      const tok = tokFor('member');
      expect((await authFetch('/admin/api/members', tok)).status).toBe(403);
      expect((await post('/admin/api/groups', tok, { name: 'g' })).status).toBe(403);
      expect((await authFetch('/admin/api/channels', tok)).status).toBe(403);
    });

    it('owner 세션 → 전체 엔드포인트 200/201(테이블 일괄)', async () => {
      for (const entry of table) {
        const r = await entry.call();
        expect([200, 201]).toContain(r.status);
      }
    });
  });

  // 신규 엔드포인트 owner 게이트(서버 콘솔 S2 Task 3b — 비번 리셋·계정 삭제·채널 멤버/그룹).
  // 기존 table(위 describe)은 순서 의존(뒤 entry가 앞 entry의 산출물을 재사용)이라 손대지 않고
  // 별도 블록으로 4종 공통 계약(무토큰 401·비owner 403·owner 200·unknown id 404)만 검증한다.
  describe('owner 게이트(신규 엔드포인트: 비번 리셋·계정 삭제·채널 멤버/그룹)', () => {
    let owner: ReturnType<AccountStore['createPassword']>;
    let member: ReturnType<AccountStore['createPassword']>;
    let ownerTok: string; let memberTok: string;
    beforeEach(async () => {
      owner = accounts.createPassword('boss', 'pw', 'Boss', { role: 'owner', status: 'active' });
      member = accounts.createPassword('mem', 'pw', 'Mem', { role: 'member', status: 'active' });
      ownerTok = sessions.issue(owner.id).token;
      memberTok = sessions.issue(member.id).token;
      await startServer();
    });

    const cases: Array<{ label: string; call: (tok: string | null, targetId: string) => Promise<Response> }> = [
      { label: 'POST members/:id/reset-password', call: (tok, id) => post(`/admin/api/members/${id}/reset-password`, tok) },
      { label: 'DELETE members/:id', call: (tok, id) => del(`/admin/api/members/${id}`, tok) },
      { label: 'POST channels/:id/members', call: (tok, id) => post(`/admin/api/channels/${id}/members`, tok, { memberIds: [] }) },
      { label: 'POST channels/:id/groups', call: (tok, id) => post(`/admin/api/channels/${id}/groups`, tok, { groupIds: [] }) },
      { label: 'GET channels/:id', call: (tok, id) => authFetch(`/admin/api/channels/${id}`, tok) },
    ];
    const targetFor: Record<string, string> = {
      'POST members/:id/reset-password': '__member__',
      'DELETE members/:id': '__member__',
      'POST channels/:id/members': 'general',
      'POST channels/:id/groups': 'general',
      'GET channels/:id': 'general',
    };

    for (const c of cases) {
      it(`${c.label}: 무토큰 → 401`, async () => {
        const target = targetFor[c.label] === '__member__' ? member.id : targetFor[c.label];
        const r = await c.call(null, target);
        expect(r.status).toBe(401);
      });
      it(`${c.label}: 비owner(member) 세션 → 403`, async () => {
        const target = targetFor[c.label] === '__member__' ? owner.id : targetFor[c.label];
        const r = await c.call(memberTok, target);
        expect(r.status).toBe(403);
      });
      it(`${c.label}: 없는 id → 404`, async () => {
        const r = await c.call(ownerTok, 'nope');
        expect(r.status).toBe(404);
      });
    }

    it('POST members/:id/reset-password: owner 세션 → 200', async () => {
      const r = await post(`/admin/api/members/${member.id}/reset-password`, ownerTok);
      expect(r.status).toBe(200);
    });
    it('DELETE members/:id: owner 세션 → 200(대상은 member — owner delete는 별도 가드 테스트)', async () => {
      const r = await del(`/admin/api/members/${member.id}`, ownerTok);
      expect(r.status).toBe(200);
    });
    it('POST channels/:id/members: owner 세션 → 200', async () => {
      const r = await post('/admin/api/channels/general/members', ownerTok, { memberIds: [] });
      expect(r.status).toBe(200);
    });
    it('POST channels/:id/groups: owner 세션 → 200', async () => {
      const r = await post('/admin/api/channels/general/groups', ownerTok, { groupIds: [] });
      expect(r.status).toBe(200);
    });
    it('GET channels/:id: owner 세션 → 200', async () => {
      const r = await authFetch('/admin/api/channels/general', ownerTok);
      expect(r.status).toBe(200);
    });
  });

  describe('멤버 API', () => {
    let owner: ReturnType<AccountStore['createPassword']>;
    let ownerTok: string;
    beforeEach(async () => {
      owner = accounts.createPassword('boss', 'pw', 'Boss', { role: 'owner', status: 'active' });
      ownerTok = sessions.issue(owner.id).token;
      await startServer();
    });

    it('GET /admin/api/members → 그룹명 포함 목록', async () => {
      const g = groups.create('디자인팀');
      const mem = accounts.createPassword('mem', 'pw', 'Mem', { role: 'member', status: 'active' });
      groups.setMembers(g.id, [mem.id]);
      const r = await authFetch('/admin/api/members', ownerTok);
      expect(r.status).toBe(200);
      const body = await r.json() as { members: any[] };
      const found = body.members.find((m) => m.id === mem.id);
      expect(found).toMatchObject({ loginId: 'mem', displayName: 'Mem', role: 'member', status: 'active', groups: ['디자인팀'] });
    });

    it('POST /admin/api/members → 즉시 active·member 역할', async () => {
      const r = await post('/admin/api/members', ownerTok, { loginId: 'newbie', displayName: 'New', password: 'pw12345' });
      expect(r.status).toBe(200);
      const created = accounts.getByLoginId('newbie');
      expect(created?.status).toBe('active');
      expect(created?.role).toBe('member');
    });

    it('POST /admin/api/members → groupId 지정 시 그 그룹 멤버로 편입', async () => {
      const g = groups.create('팀A');
      const r = await post('/admin/api/members', ownerTok, { loginId: 'joiner', displayName: 'J', password: 'pw12345', groupId: g.id });
      expect(r.status).toBe(200);
      const created = accounts.getByLoginId('joiner')!;
      expect(groups.get(g.id)?.memberIds).toContain(created.id);
    });

    it('POST /admin/api/members → loginId 중복은 409', async () => {
      await post('/admin/api/members', ownerTok, { loginId: 'dup', displayName: 'D1', password: 'pw12345' });
      const r = await post('/admin/api/members', ownerTok, { loginId: 'dup', displayName: 'D2', password: 'pw12345' });
      expect(r.status).toBe(409);
    });

    it('POST /admin/api/members → 잘못된 본문(JSON 아님) → 400', async () => {
      const r = await authFetch('/admin/api/members', ownerTok, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
      expect(r.status).toBe(400);
    });

    it('POST /admin/api/members → 과대 본문(MAX_BODY_BYTES 초과) → 400 응답(connection reset 아님)', async () => {
      // 64KB 상한을 초과하는 본문을 생성(과대 data 필드). 소켓 파괴 없이 정상적으로 400 응답을 받아야 함.
      const oversizeBody = { loginId: 'x', displayName: 'y', password: 'pw', data: 'x'.repeat(64 * 1024 + 1) };
      const r = await post('/admin/api/members', ownerTok, oversizeBody);
      expect(r.status).toBe(400); // ECONNRESET 같은 connection error 아니라 actual 400
      const body = await r.json() as Record<string, unknown>;
      expect(body.error).toBe('bad_body');
    });

    it('POST /admin/api/members → 필수 필드 누락 → 400', async () => {
      const r = await post('/admin/api/members', ownerTok, { loginId: '', displayName: '', password: '' });
      expect(r.status).toBe(400);
    });

    it('POST /admin/api/members/:id/status → 상태 변경', async () => {
      const mem = accounts.createPassword('mem', 'pw', 'Mem'); // 기본 pending
      const r = await post(`/admin/api/members/${mem.id}/status`, ownerTok, { status: 'active' });
      expect(r.status).toBe(200);
      expect(accounts.get(mem.id)?.status).toBe('active');
    });

    it('POST /admin/api/members/:id/status → 없는 id는 404', async () => {
      const r = await post('/admin/api/members/nope/status', ownerTok, { status: 'active' });
      expect(r.status).toBe(404);
    });

    it('POST /admin/api/members/:id/status → 잘못된 status값 400', async () => {
      const mem = accounts.createPassword('mem', 'pw', 'Mem', { role: 'member', status: 'active' });
      const r = await post(`/admin/api/members/${mem.id}/status`, ownerTok, { status: 'bogus' });
      expect(r.status).toBe(400);
    });

    it('POST /admin/api/members/:id/status → owner 자기 정지 금지(403)', async () => {
      const r = await post(`/admin/api/members/${owner.id}/status`, ownerTok, { status: 'suspended' });
      expect(r.status).toBe(403);
      expect(accounts.get(owner.id)?.status).toBe('active'); // 변경 안 됨
    });

    it('POST /admin/api/members/:id/permissions → 소독 후 저장', async () => {
      const mem = accounts.createPassword('mem', 'pw', 'Mem', { role: 'member', status: 'active' });
      const r = await post(`/admin/api/members/${mem.id}/permissions`, ownerTok, { permissions: ['wiki.approve', 'bogus', 'wiki.approve'] });
      expect(r.status).toBe(200);
      expect(accounts.get(mem.id)?.permissions).toEqual(['wiki.approve']);
    });

    it('POST /admin/api/members/:id/permissions → 없는 id는 404', async () => {
      const r = await post('/admin/api/members/nope/permissions', ownerTok, { permissions: [] });
      expect(r.status).toBe(404);
    });

    it('POST /admin/api/members/:id/reset-password → 새 임시 비번 반환, 새 비번은 통과·구 비번은 실패', async () => {
      const mem = accounts.createPassword('reset-me', 'oldpw123', 'ResetMe', { role: 'member', status: 'active' });
      const r = await post(`/admin/api/members/${mem.id}/reset-password`, ownerTok);
      expect(r.status).toBe(200);
      const body = await r.json() as { tempPassword: string };
      expect(typeof body.tempPassword).toBe('string');
      expect(body.tempPassword.length).toBeGreaterThanOrEqual(8); // ~10자
      expect(accounts.verifyPassword('reset-me', body.tempPassword)?.id).toBe(mem.id);
      expect(accounts.verifyPassword('reset-me', 'oldpw123')).toBeNull(); // 구 비번은 무효화
    });

    it('POST /admin/api/members/:id/reset-password → 없는 id는 404', async () => {
      const r = await post('/admin/api/members/nope/reset-password', ownerTok);
      expect(r.status).toBe(404);
    });

    it('DELETE /admin/api/members/:id → 삭제 + 그룹 memberIds 캐스케이드 정리', async () => {
      const mem = accounts.createPassword('del-me', 'pw12345', 'DelMe', { role: 'member', status: 'active' });
      const g1 = groups.create('그룹1'); const g2 = groups.create('그룹2');
      groups.setMembers(g1.id, [mem.id, owner.id]);
      groups.setMembers(g2.id, [mem.id]);
      const r = await del(`/admin/api/members/${mem.id}`, ownerTok);
      expect(r.status).toBe(200);
      expect(accounts.get(mem.id)).toBeNull();
      expect(groups.get(g1.id)?.memberIds).toEqual([owner.id]); // mem만 빠지고 owner는 남음
      expect(groups.get(g2.id)?.memberIds).toEqual([]);
    });

    it('DELETE /admin/api/members/:id → 비공개 채널 memberIds도 캐스케이드 정리(유령 참조 방지)', async () => {
      const mem = accounts.createPassword('ch-del', 'pw12345', 'ChDel', { role: 'member', status: 'active' });
      chat.createChannel('room1'); chat.createChannel('room2');
      const room1 = chat.listChannels().find((c) => c.name === 'room1')!;
      const room2 = chat.listChannels().find((c) => c.name === 'room2')!;
      chat.setMembers(room1.id, [mem.id, owner.id]);
      chat.setMembers(room2.id, [mem.id]);
      const r = await del(`/admin/api/members/${mem.id}`, ownerTok);
      expect(r.status).toBe(200);
      expect(chat.listChannels().find((c) => c.id === room1.id)?.memberIds).toEqual([owner.id]);
      expect(chat.listChannels().find((c) => c.id === room2.id)?.memberIds).toEqual([]);
    });

    it('DELETE /admin/api/members/:id → 없는 id는 404', async () => {
      const r = await del('/admin/api/members/nope', ownerTok);
      expect(r.status).toBe(404);
    });

    it('DELETE /admin/api/members/:id → 자기 자신 삭제 금지(403)', async () => {
      const r = await del(`/admin/api/members/${owner.id}`, ownerTok);
      expect(r.status).toBe(403);
      expect(accounts.get(owner.id)).not.toBeNull();
    });

    it('DELETE /admin/api/members/:id → 다른 owner 삭제 금지(403)', async () => {
      const owner2 = accounts.createPassword('boss2', 'pw', 'Boss2', { role: 'owner', status: 'active' });
      const r = await del(`/admin/api/members/${owner2.id}`, ownerTok);
      expect(r.status).toBe(403);
      expect(accounts.get(owner2.id)).not.toBeNull();
    });
  });

  describe('그룹 API', () => {
    let owner: ReturnType<AccountStore['createPassword']>;
    let ownerTok: string;
    beforeEach(async () => {
      owner = accounts.createPassword('boss', 'pw', 'Boss', { role: 'owner', status: 'active' });
      ownerTok = sessions.issue(owner.id).token;
      await startServer();
    });

    it('GET /admin/api/groups → 목록', async () => {
      groups.create('a'); groups.create('b');
      const r = await authFetch('/admin/api/groups', ownerTok);
      expect(r.status).toBe(200);
      const body = await r.json() as { groups: any[] };
      expect(body.groups.map((g) => g.name).sort()).toEqual(['a', 'b']);
    });

    it('POST /admin/api/groups → 생성', async () => {
      const r = await post('/admin/api/groups', ownerTok, { name: '새그룹' });
      expect(r.status).toBe(200);
      const body = await r.json() as { group: { id: string; name: string } };
      expect(body.group.name).toBe('새그룹');
      expect(groups.get(body.group.id)).not.toBeNull();
    });

    it('POST /admin/api/groups → 빈 이름 400', async () => {
      const r = await post('/admin/api/groups', ownerTok, { name: '   ' });
      expect(r.status).toBe(400);
    });

    it('PATCH /admin/api/groups/:id → 넘긴 필드만 갱신(부분 patch)', async () => {
      const g = groups.create('원래이름');
      const mem = accounts.createPassword('mem', 'pw', 'Mem', { role: 'member', status: 'active' });
      const r = await patch(`/admin/api/groups/${g.id}`, ownerTok, { memberIds: [mem.id] });
      expect(r.status).toBe(200);
      const after = groups.get(g.id)!;
      expect(after.name).toBe('원래이름'); // name 안 건드림
      expect(after.memberIds).toEqual([mem.id]);
    });

    it('PATCH /admin/api/groups/:id → name·permissions·channelIds 갱신', async () => {
      const g = groups.create('old');
      const r = await patch(`/admin/api/groups/${g.id}`, ownerTok, { name: 'new', permissions: ['wiki.approve'], channelIds: ['general'] });
      expect(r.status).toBe(200);
      const after = groups.get(g.id)!;
      expect(after.name).toBe('new');
      expect(after.permissions).toEqual(['wiki.approve']);
      expect(after.channelIds).toEqual(['general']);
    });

    it('PATCH /admin/api/groups/:id → 없는 id는 404', async () => {
      const r = await patch('/admin/api/groups/nope', ownerTok, { name: 'x' });
      expect(r.status).toBe(404);
    });

    it('DELETE /admin/api/groups/:id → 삭제', async () => {
      const g = groups.create('temp');
      const r = await del(`/admin/api/groups/${g.id}`, ownerTok);
      expect(r.status).toBe(200);
      expect(groups.get(g.id)).toBeNull();
    });

    it('DELETE /admin/api/groups/:id → 없는 id는 404', async () => {
      const r = await del('/admin/api/groups/nope', ownerTok);
      expect(r.status).toBe(404);
    });
  });

  describe('채널 API', () => {
    let owner: ReturnType<AccountStore['createPassword']>;
    let ownerTok: string;
    beforeEach(async () => {
      owner = accounts.createPassword('boss', 'pw', 'Boss', { role: 'owner', status: 'active' });
      ownerTok = sessions.issue(owner.id).token;
      await startServer();
    });

    it('GET /admin/api/channels → 메타만(대화 내용 없음)', async () => {
      chat.createChannel('dev');
      chat.appendMessage('general', { authorId: owner.id, text: '비밀 메시지' });
      const r = await authFetch('/admin/api/channels', ownerTok);
      expect(r.status).toBe(200);
      const body = await r.json() as { channels: any[] };
      expect(body.channels.map((c) => c.name).sort()).toEqual(['dev', 'general']);
      const text = JSON.stringify(body);
      expect(text).not.toContain('비밀 메시지');
      const general = body.channels.find((c) => c.id === 'general');
      expect(general).toMatchObject({ id: 'general', name: 'general', mode: 'chat', visibility: 'public' });
      expect(typeof general.memberCount).toBe('number');
    });

    it('GET /admin/api/channels → groups(그룹명 배열) 동봉 — 이 채널을 channelIds에 담은 그룹만', async () => {
      const dev = chat.createChannel('dev')!;
      const g1 = groups.create('디자인팀'); const g2 = groups.create('개발팀');
      groups.setChannels(g1.id, [dev.id]);
      groups.setChannels(g2.id, ['general', dev.id]);
      const r = await authFetch('/admin/api/channels', ownerTok);
      const body = await r.json() as { channels: any[] };
      const devDto = body.channels.find((c) => c.id === dev.id);
      expect(devDto.groups.sort()).toEqual(['개발팀', '디자인팀']);
      const generalDto = body.channels.find((c) => c.id === 'general');
      expect(generalDto.groups).toEqual(['개발팀']);
    });

    it('GET /admin/api/channels/:id → 상세(memberIds·groupIds 포함)', async () => {
      const mem = accounts.createPassword('mem', 'pw', 'Mem', { role: 'member', status: 'active' });
      const g = groups.create('그룹A');
      chat.setMembers('general', [mem.id]);
      groups.setChannels(g.id, ['general']);
      const r = await authFetch('/admin/api/channels/general', ownerTok);
      expect(r.status).toBe(200);
      const body = await r.json() as { id: string; name: string; visibility: string; memberIds: string[]; groupIds: string[] };
      expect(body).toMatchObject({ id: 'general', name: 'general', visibility: 'public' });
      expect(body.memberIds).toEqual([mem.id]);
      expect(body.groupIds).toEqual([g.id]);
    });

    it('GET /admin/api/channels/:id → 없는 채널 404', async () => {
      const r = await authFetch('/admin/api/channels/nope', ownerTok);
      expect(r.status).toBe(404);
    });

    it('POST /admin/api/channels/:id/members → 멤버 집합 교체, 실존하지 않는 id는 소독', async () => {
      const mem = accounts.createPassword('mem', 'pw', 'Mem', { role: 'member', status: 'active' });
      const r = await post('/admin/api/channels/general/members', ownerTok, { memberIds: [mem.id, 'ghost-id'] });
      expect(r.status).toBe(200);
      expect(chat.listChannels().find((c) => c.id === 'general')?.memberIds).toEqual([mem.id]);
    });

    it('POST /admin/api/channels/:id/members → 없는 채널 404', async () => {
      const r = await post('/admin/api/channels/nope/members', ownerTok, { memberIds: [] });
      expect(r.status).toBe(404);
    });

    it('POST /admin/api/channels/:id/members → 잘못된 본문(memberIds 배열 아님) 400', async () => {
      const r = await post('/admin/api/channels/general/members', ownerTok, { memberIds: 'not-array' });
      expect(r.status).toBe(400);
    });

    it('POST /admin/api/channels/:id/groups → 접근 그룹 집합 교체(추가+제거 양방향), 실존하지 않는 id는 소독', async () => {
      const dev = chat.createChannel('dev')!;
      const g1 = groups.create('그룹1'); // 처음엔 dev 접근 有
      const g2 = groups.create('그룹2'); // 처음엔 dev 접근 無
      groups.setChannels(g1.id, [dev.id]);
      const r = await post(`/admin/api/channels/${dev.id}/groups`, ownerTok, { groupIds: [g2.id, 'ghost-group'] });
      expect(r.status).toBe(200);
      expect(groups.get(g1.id)?.channelIds).not.toContain(dev.id); // 빠짐
      expect(groups.get(g2.id)?.channelIds).toContain(dev.id); // 추가됨
    });

    it('POST /admin/api/channels/:id/groups → 없는 채널 404', async () => {
      const r = await post('/admin/api/channels/nope/groups', ownerTok, { groupIds: [] });
      expect(r.status).toBe(404);
    });

    it('POST /admin/api/channels/:id/groups → 잘못된 본문(groupIds 배열 아님) 400', async () => {
      const r = await post('/admin/api/channels/general/groups', ownerTok, { groupIds: 'not-array' });
      expect(r.status).toBe(400);
    });

    it('POST /admin/api/channels/:id/visibility → 전환', async () => {
      const r = await post('/admin/api/channels/general/visibility', ownerTok, { visibility: 'private' });
      expect(r.status).toBe(200);
      expect(chat.listChannels().find((c) => c.id === 'general')?.visibility).toBe('private');
    });

    it('POST /admin/api/channels/:id/visibility → 잘못된 값 400', async () => {
      const r = await post('/admin/api/channels/general/visibility', ownerTok, { visibility: 'bogus' });
      expect(r.status).toBe(400);
    });

    it('POST /admin/api/channels/:id/visibility → 없는 채널 404', async () => {
      const r = await post('/admin/api/channels/nope/visibility', ownerTok, { visibility: 'private' });
      expect(r.status).toBe(404);
    });

    it('DELETE /admin/api/channels/:id → 삭제', async () => {
      chat.createChannel('temp-ch');
      const id = chat.listChannels().find((c) => c.name === 'temp-ch')!.id;
      const r = await del(`/admin/api/channels/${id}`, ownerTok);
      expect(r.status).toBe(200);
      expect(chat.listChannels().find((c) => c.id === id)).toBeUndefined();
    });

    it('DELETE /admin/api/channels/:id → 없는 채널 404', async () => {
      const r = await del('/admin/api/channels/nope', ownerTok);
      expect(r.status).toBe(404);
    });
  });

  // 서버 콘솔 S3 Task 1: 모델·MCP 관리 api. brains-file/ollama/api-brain/mcp-file 재사용.
  describe('모델·MCP API(서버 콘솔 S3 Task 1)', () => {
    let owner: ReturnType<AccountStore['createPassword']>;
    let member: ReturnType<AccountStore['createPassword']>;
    let ownerTok: string; let memberTok: string;
    beforeEach(async () => {
      owner = accounts.createPassword('boss', 'pw', 'Boss', { role: 'owner', status: 'active' });
      member = accounts.createPassword('mem', 'pw', 'Mem', { role: 'member', status: 'active' });
      ownerTok = sessions.issue(owner.id).token;
      memberTok = sessions.issue(member.id).token;
      await startServer();
    });

    describe('owner 게이트(각 엔드포인트 owner 200·비owner 403·무토큰 401)', () => {
      const cases: Array<{ label: string; call: (tok: string | null) => Promise<Response> }> = [
        { label: 'GET models', call: (tok) => authFetch('/admin/api/models', tok) },
        { label: 'POST models/ollama', call: (tok) => post('/admin/api/models/ollama', tok, { model: 'qwen3:8b', name: 'gate-ollama' }) },
        { label: 'POST models/api-key', call: (tok) => post('/admin/api/models/api-key', tok, { apiKey: 'gate-key' }) },
        { label: 'POST models/default', call: (tok) => post('/admin/api/models/default', tok, { key: 'anthropic' }) },
        { label: 'DELETE models/:key', call: (tok) => del('/admin/api/models/gate-ollama', tok) },
        { label: 'GET mcp', call: (tok) => authFetch('/admin/api/mcp', tok) },
        { label: 'POST mcp', call: (tok) => post('/admin/api/mcp', tok, { name: 'gate-mcp', commandOrUrl: 'npx' }) },
        { label: 'DELETE mcp/:name', call: (tok) => del('/admin/api/mcp/gate-mcp', tok) },
      ];
      for (const c of cases) {
        it(`${c.label}: 무토큰 → 401`, async () => {
          expect((await c.call(null)).status).toBe(401);
        });
        it(`${c.label}: 비owner(member) 세션 → 403`, async () => {
          expect((await c.call(memberTok)).status).toBe(403);
        });
      }
      it('owner 세션 → 전체 엔드포인트 순차 200(뒤 항목이 앞 항목의 산출물을 재사용)', async () => {
        for (const c of cases) {
          const r = await c.call(ownerTok);
          expect(r.status).toBe(200);
        }
      });
    });

    describe('GET /admin/api/models', () => {
      it('등록된 두뇌 없음 → 빈 목록·default 빈 문자열·harness cli', async () => {
        const r = await authFetch('/admin/api/models', ownerTok);
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ default: '', harness: 'cli', models: [] });
      });
    });

    describe('POST /admin/api/models/ollama', () => {
      it('로컬 모델 추가 → GET models에 openai-api provider로 보임', async () => {
        const r = await post('/admin/api/models/ollama', ownerTok, { model: 'qwen3:8b', name: 'qwen3-8b' });
        expect(r.status).toBe(200);
        const listRes = await authFetch('/admin/api/models', ownerTok);
        const body = await listRes.json() as { models: any[] };
        expect(body.models).toContainEqual({ key: 'qwen3-8b', provider: 'openai-api', model: 'qwen3:8b', isDefault: false, hasApiKey: false });
      });

      it('setDefault:true → 기본 전환 + harness engram', async () => {
        await post('/admin/api/models/ollama', ownerTok, { model: 'qwen3:8b', name: 'qwen3-8b', setDefault: true });
        const listRes = await authFetch('/admin/api/models', ownerTok);
        const body = await listRes.json() as { default: string; harness: string; models: any[] };
        expect(body.default).toBe('qwen3-8b');
        expect(body.harness).toBe('engram');
        expect(body.models.find((m) => m.key === 'qwen3-8b')?.isDefault).toBe(true);
      });

      it('필수 필드 누락(model 없음) → 400', async () => {
        const r = await post('/admin/api/models/ollama', ownerTok, { name: 'x' });
        expect(r.status).toBe(400);
      });
    });

    describe('POST /admin/api/models/api-key — ★보안 핵심: 키 원문 미유출', () => {
      it('저장 후 GET models 응답에 키 원문이 어디에도 없음, hasApiKey만 true', async () => {
        const secret = 'sk-ant-super-secret-12345';
        const saveRes = await post('/admin/api/models/api-key', ownerTok, { apiKey: secret, setDefault: true });
        expect(saveRes.status).toBe(200);
        const saveText = await saveRes.text();
        expect(saveText).not.toContain(secret); // 저장 응답 자체에도 없어야 함

        const listRes = await authFetch('/admin/api/models', ownerTok);
        const rawText = await listRes.text();
        expect(rawText).not.toContain(secret); // 핵심 단언: 원문이 응답 본문 전체에 없음
        const body = JSON.parse(rawText) as { default: string; harness: string; models: any[] };
        expect(body.default).toBe('anthropic');
        expect(body.harness).toBe('engram');
        const entry = body.models.find((m) => m.key === 'anthropic');
        expect(entry).toMatchObject({ provider: 'anthropic-api', isDefault: true, hasApiKey: true });
        expect(Object.keys(entry)).not.toContain('apiKey');
      });

      it('빈 apiKey → 400(저장할 게 없음)', async () => {
        const r = await post('/admin/api/models/api-key', ownerTok, { apiKey: '' });
        expect(r.status).toBe(400);
      });
    });

    describe('POST /admin/api/models/default', () => {
      it('기본 전환', async () => {
        await post('/admin/api/models/ollama', ownerTok, { model: 'm1', name: 'a' });
        await post('/admin/api/models/ollama', ownerTok, { model: 'm2', name: 'b', setDefault: true });
        const r = await post('/admin/api/models/default', ownerTok, { key: 'a' });
        expect(r.status).toBe(200);
        const body = await (await authFetch('/admin/api/models', ownerTok)).json() as { default: string; models: any[] };
        expect(body.default).toBe('a');
        expect(body.models.find((m) => m.key === 'a')?.isDefault).toBe(true);
        expect(body.models.find((m) => m.key === 'b')?.isDefault).toBe(false);
      });

      it('존재하지 않는 key → 404', async () => {
        const r = await post('/admin/api/models/default', ownerTok, { key: 'nope' });
        expect(r.status).toBe(404);
      });
    });

    describe('DELETE /admin/api/models/:key', () => {
      it('기본 모델 삭제 시도 → 400(먼저 다른 모델을 기본으로)', async () => {
        await post('/admin/api/models/ollama', ownerTok, { model: 'm1', name: 'a', setDefault: true });
        const r = await del('/admin/api/models/a', ownerTok);
        expect(r.status).toBe(400);
        const body = await (await authFetch('/admin/api/models', ownerTok)).json() as { models: any[] };
        expect(body.models.find((m) => m.key === 'a')).toBeDefined(); // 안 지워짐
      });

      it('비기본 모델 삭제 → 200 + 목록에서 제거', async () => {
        await post('/admin/api/models/ollama', ownerTok, { model: 'm1', name: 'a', setDefault: true });
        await post('/admin/api/models/ollama', ownerTok, { model: 'm2', name: 'b' });
        const r = await del('/admin/api/models/b', ownerTok);
        expect(r.status).toBe(200);
        const body = await (await authFetch('/admin/api/models', ownerTok)).json() as { models: any[] };
        expect(body.models.find((m) => m.key === 'b')).toBeUndefined();
      });

      it('존재하지 않는 key → 404', async () => {
        const r = await del('/admin/api/models/nope', ownerTok);
        expect(r.status).toBe(404);
      });
    });

    describe('GET /admin/api/mcp', () => {
      it('등록된 서버 없음 → 빈 목록', async () => {
        const r = await authFetch('/admin/api/mcp', ownerTok);
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ servers: [] });
      });
    });

    describe('POST /admin/api/mcp', () => {
      it('추가 → GET에 보임', async () => {
        const r = await post('/admin/api/mcp', ownerTok, { name: 'github', commandOrUrl: 'npx' });
        expect(r.status).toBe(200);
        const body = await (await authFetch('/admin/api/mcp', ownerTok)).json() as { servers: any[] };
        expect(body.servers).toContainEqual({ name: 'github', command: 'npx' });
      });

      it('중복 이름 → 409', async () => {
        await post('/admin/api/mcp', ownerTok, { name: 'github', commandOrUrl: 'npx' });
        const r = await post('/admin/api/mcp', ownerTok, { name: 'github', commandOrUrl: 'npx' });
        expect(r.status).toBe(409);
      });

      it('잘못된 이름(규칙 위반) → 400', async () => {
        const r = await post('/admin/api/mcp', ownerTok, { name: 'Bad Name', commandOrUrl: 'npx' });
        expect(r.status).toBe(400);
      });

      it('빈 commandOrUrl → 400', async () => {
        const r = await post('/admin/api/mcp', ownerTok, { name: 'empty-cmd', commandOrUrl: '' });
        expect(r.status).toBe(400);
      });
    });

    describe('DELETE /admin/api/mcp/:name', () => {
      it('삭제 → 200 + 목록에서 제거', async () => {
        await post('/admin/api/mcp', ownerTok, { name: 'github', commandOrUrl: 'npx' });
        const r = await del('/admin/api/mcp/github', ownerTok);
        expect(r.status).toBe(200);
        const body = await (await authFetch('/admin/api/mcp', ownerTok)).json() as { servers: any[] };
        expect(body.servers).toEqual([]);
      });

      it('존재하지 않는 이름 → 404', async () => {
        const r = await del('/admin/api/mcp/nope', ownerTok);
        expect(r.status).toBe(404);
      });

      it("source='claude'(클로드 미러) 항목 삭제 → 403, 목록에 그대로 남음", async () => {
        // mirrorClaudeMcp가 만드는 형태를 그대로 시뮬레이트(addMcpServer로는 source:'claude' 항목을
        // 만들 수 없다 — 실제로도 그건 부트 시점 mirrorClaudeMcp 전용 경로).
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(path.join(configDir, 'mcp.json'), JSON.stringify({
          mcpServers: { synced: { command: 'npx', args: ['-y', 'foo'], env: {}, source: 'claude' } },
        }, null, 2));
        const r = await del('/admin/api/mcp/synced', ownerTok);
        expect(r.status).toBe(403);
        const body = await (await authFetch('/admin/api/mcp', ownerTok)).json() as { servers: any[] };
        expect(body.servers.find((s) => s.name === 'synced')).toBeDefined();
      });
    });
  });

  describe('위키·서버설정·preset API(서버 콘솔 S3 Task 2)', () => {
    let owner: ReturnType<AccountStore['createPassword']>;
    let member: ReturnType<AccountStore['createPassword']>;
    let ownerTok: string; let memberTok: string;
    beforeEach(async () => {
      owner = accounts.createPassword('boss', 'pw', 'Boss', { role: 'owner', status: 'active' });
      member = accounts.createPassword('mem', 'pw', 'Mem', { role: 'member', status: 'active' });
      ownerTok = sessions.issue(owner.id).token;
      memberTok = sessions.issue(member.id).token;
      await startServer();
    });

    describe('owner 게이트(무토큰 401·비owner 403·owner 200)', () => {
      const cases: Array<{ label: string; call: (tok: string | null) => Promise<Response> }> = [
        { label: 'GET wiki', call: (tok) => authFetch('/admin/api/wiki', tok) },
        { label: 'POST wiki/remote', call: (tok) => post('/admin/api/wiki/remote', tok, { url: 'https://example.com/w.git', branch: 'main' }) },
        { label: 'GET server-settings', call: (tok) => authFetch('/admin/api/server-settings', tok) },
        { label: 'POST server-settings', call: (tok) => post('/admin/api/server-settings', tok, { serverName: 'Gate' }) },
        { label: 'GET preset', call: (tok) => authFetch('/admin/api/preset', tok) },
      ];
      for (const c of cases) {
        it(`${c.label}: 무토큰 → 401`, async () => {
          expect((await c.call(null)).status).toBe(401);
        });
        it(`${c.label}: 비owner(member) 세션 → 403`, async () => {
          expect((await c.call(memberTok)).status).toBe(403);
        });
        it(`${c.label}: owner 세션 → 200`, async () => {
          expect((await c.call(ownerTok)).status).toBe(200);
        });
      }
    });

    describe('GET /admin/api/wiki', () => {
      it('remote 미설정 + 통계는 overview와 같은 소스(페이지 2·승인대기 1)', async () => {
        const r = await authFetch('/admin/api/wiki', ownerTok);
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ remote: {}, pages: 2, pendingProposals: 1 });
      });

      it('remote 저장 후 GET에 url/branch 반영', async () => {
        await post('/admin/api/wiki/remote', ownerTok, { url: 'https://example.com/w.git', branch: 'dev' });
        const body = await (await authFetch('/admin/api/wiki', ownerTok)).json() as any;
        expect(body.remote).toEqual({ url: 'https://example.com/w.git', branch: 'dev' });
      });
    });

    describe('POST /admin/api/wiki/remote', () => {
      it('저장 → 200 + saveWikiRemote 왕복', async () => {
        const r = await post('/admin/api/wiki/remote', ownerTok, { url: 'https://example.com/w.git', branch: 'main' });
        expect(r.status).toBe(200);
      });

      it('branch 생략 시 기본값 main(saveWikiRemote 관례)', async () => {
        await post('/admin/api/wiki/remote', ownerTok, { url: 'https://example.com/w.git' });
        const body = await (await authFetch('/admin/api/wiki', ownerTok)).json() as any;
        expect(body.remote.branch).toBe('main');
      });
    });

    describe('GET /admin/api/server-settings — ★보안 핵심: oidc secret 미유출', () => {
      it('기본값(auth.json 없음): exposure local·codingMode auto·hasOidcSecret false·serverName 없음', async () => {
        const r = await authFetch('/admin/api/server-settings', ownerTok);
        expect(r.status).toBe(200);
        const body = await r.json() as any;
        expect(body).toMatchObject({ port: 47800, bind: '127.0.0.1', exposure: 'local', hasOidcSecret: false, codingMode: 'auto' });
        expect(body.serverName).toBeUndefined();
      });

      it('oidc 저장 후 GET 응답 원문 전체에 clientSecret 값이 없음, hasOidcSecret만 true', async () => {
        const secret = 'super-secret-oidc-value';
        await post('/admin/api/server-settings', ownerTok, {
          oidc: { issuer: 'https://idp.example', clientId: 'cid', clientSecret: secret },
        });
        const r = await authFetch('/admin/api/server-settings', ownerTok);
        const rawText = await r.text();
        expect(rawText).not.toContain(secret); // 핵심 단언: 원문이 응답 본문 전체에 없음
        const body = JSON.parse(rawText);
        expect(body.hasOidcSecret).toBe(true);
        expect(body.oidcIssuer).toBe('https://idp.example');
        expect(body.oidcClientId).toBe('cid');
        expect(Object.keys(body)).not.toContain('clientSecret');
      });
    });

    describe('POST /admin/api/server-settings', () => {
      it('serverName 저장 → GET 왕복', async () => {
        const r = await post('/admin/api/server-settings', ownerTok, { serverName: 'My Team' });
        expect(r.status).toBe(200);
        const body = await (await authFetch('/admin/api/server-settings', ownerTok)).json() as any;
        expect(body.serverName).toBe('My Team');
      });

      it('clientSecret 빈값 → 기존 시크릿 보존(파일 직접 확인), 다른 필드는 갱신', async () => {
        await post('/admin/api/server-settings', ownerTok, {
          oidc: { issuer: 'https://idp.example', clientId: 'cid', clientSecret: 'original-secret' },
        });
        await post('/admin/api/server-settings', ownerTok, {
          oidc: { issuer: 'https://idp2.example', clientId: 'cid2', clientSecret: '' },
        });
        const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'auth.json'), 'utf8'));
        expect(raw.oidc.clientSecret).toBe('original-secret'); // 보존됨
        expect(raw.oidc.issuer).toBe('https://idp2.example'); // 다른 필드는 갱신됨
        const getBody = await (await authFetch('/admin/api/server-settings', ownerTok)).json() as any;
        expect(getBody.hasOidcSecret).toBe(true);
      });

      it('codingMode 왕복(off→auto)', async () => {
        await post('/admin/api/server-settings', ownerTok, { codingMode: 'off' });
        expect(((await (await authFetch('/admin/api/server-settings', ownerTok)).json()) as any).codingMode).toBe('off');
        await post('/admin/api/server-settings', ownerTok, { codingMode: 'auto' });
        expect(((await (await authFetch('/admin/api/server-settings', ownerTok)).json()) as any).codingMode).toBe('auto');
      });

      it('잘못된 codingMode → 400', async () => {
        const r = await post('/admin/api/server-settings', ownerTok, { codingMode: 'restricted' });
        expect(r.status).toBe(400);
      });

      it("exposure 'local'→bind 127.0.0.1, 'lan'→bind 0.0.0.0", async () => {
        await post('/admin/api/server-settings', ownerTok, { exposure: 'lan' });
        expect(((await (await authFetch('/admin/api/server-settings', ownerTok)).json()) as any).bind).toBe('0.0.0.0');
        await post('/admin/api/server-settings', ownerTok, { exposure: 'local' });
        expect(((await (await authFetch('/admin/api/server-settings', ownerTok)).json()) as any).bind).toBe('127.0.0.1');
      });

      it("exposure 'internet'→bind 0.0.0.0(조회 시 exposure는 'lan'으로 표시 — bind는 2값뿐이라 문서화된 한계)", async () => {
        await post('/admin/api/server-settings', ownerTok, { exposure: 'internet' });
        const body = await (await authFetch('/admin/api/server-settings', ownerTok)).json() as any;
        expect(body.bind).toBe('0.0.0.0');
        expect(body.exposure).toBe('lan');
      });

      it('잘못된 exposure → 400', async () => {
        const r = await post('/admin/api/server-settings', ownerTok, { exposure: 'space' });
        expect(r.status).toBe(400);
      });

      it('port 저장 → GET 왕복', async () => {
        await post('/admin/api/server-settings', ownerTok, { port: 5555 });
        expect(((await (await authFetch('/admin/api/server-settings', ownerTok)).json()) as any).port).toBe(5555);
      });

      it('범위 밖 port → 400, 기존 값 보존', async () => {
        const r = await post('/admin/api/server-settings', ownerTok, { port: 99999 });
        expect(r.status).toBe(400);
        expect(((await (await authFetch('/admin/api/server-settings', ownerTok)).json()) as any).port).toBe(47800);
      });

      it('invalid bind(화이트리스트 아님) → 400, chat.json 미변경', async () => {
        // 먼저 유효한 bind 설정
        await post('/admin/api/server-settings', ownerTok, { exposure: 'local' });
        const oldBind = ((await (await authFetch('/admin/api/server-settings', ownerTok)).json()) as any).bind;
        expect(oldBind).toBe('127.0.0.1');
        // 잘못된 bind로 시도
        const r = await post('/admin/api/server-settings', ownerTok, { bind: 'not-an-ip' });
        expect(r.status).toBe(400);
        // 기존 값이 보존되었는지 확인
        const newBind = ((await (await authFetch('/admin/api/server-settings', ownerTok)).json()) as any).bind;
        expect(newBind).toBe(oldBind);
      });

      it('bind 화이트리스트: 127.0.0.1과 0.0.0.0만 허용', async () => {
        // 127.0.0.1 허용
        const r1 = await post('/admin/api/server-settings', ownerTok, { bind: '127.0.0.1' });
        expect(r1.status).toBe(200);
        expect(((await (await authFetch('/admin/api/server-settings', ownerTok)).json()) as any).bind).toBe('127.0.0.1');
        // 0.0.0.0 허용
        const r2 = await post('/admin/api/server-settings', ownerTok, { bind: '0.0.0.0' });
        expect(r2.status).toBe(200);
        expect(((await (await authFetch('/admin/api/server-settings', ownerTok)).json()) as any).bind).toBe('0.0.0.0');
      });

      it('port boolean 거부 → 400', async () => {
        const r = await post('/admin/api/server-settings', ownerTok, { port: true as any });
        expect(r.status).toBe(400);
      });

      it('port 형식 오류(문자) → 400', async () => {
        const r = await post('/admin/api/server-settings', ownerTok, { port: 'abc' });
        expect(r.status).toBe(400);
      });

      it('OIDC 부분 업데이트: clientSecret만 보내면 issuer/clientId 보존', async () => {
        // 먼저 전체 OIDC 설정
        await post('/admin/api/server-settings', ownerTok, {
          oidc: { issuer: 'https://idp.example', clientId: 'cid', clientSecret: 'secret1' },
        });
        // clientSecret만 업데이트
        await post('/admin/api/server-settings', ownerTok, {
          oidc: { clientSecret: 'secret2' },
        });
        const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'auth.json'), 'utf8'));
        expect(raw.oidc.issuer).toBe('https://idp.example'); // 보존됨
        expect(raw.oidc.clientId).toBe('cid'); // 보존됨
        expect(raw.oidc.clientSecret).toBe('secret2'); // 업데이트됨
      });

      it('OIDC 부분 업데이트: issuer만 보내면 clientId/clientSecret 보존', async () => {
        // 먼저 전체 OIDC 설정
        await post('/admin/api/server-settings', ownerTok, {
          oidc: { issuer: 'https://idp.example', clientId: 'cid', clientSecret: 'secret' },
        });
        // issuer만 업데이트
        await post('/admin/api/server-settings', ownerTok, {
          oidc: { issuer: 'https://idp2.example' },
        });
        const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'auth.json'), 'utf8'));
        expect(raw.oidc.issuer).toBe('https://idp2.example'); // 업데이트됨
        expect(raw.oidc.clientId).toBe('cid'); // 보존됨
        expect(raw.oidc.clientSecret).toBe('secret'); // 보존됨
      });
    });

    describe('GET /admin/api/preset', () => {
      it('다운로드 헤더(Content-Disposition attachment) + {name,endpoint} 본문', async () => {
        const r = await authFetch('/admin/api/preset', ownerTok);
        expect(r.status).toBe(200);
        expect(r.headers.get('content-disposition')).toBe('attachment; filename="preset.json"');
        expect(r.headers.get('content-type')).toContain('application/json');
        const body = await r.json() as any;
        expect(body).toEqual({ name: 'Engram Server', endpoint: 'ws://127.0.0.1:47800' });
      });

      it('serverName 저장 후 preset.name에 반영', async () => {
        await post('/admin/api/server-settings', ownerTok, { serverName: 'My Team' });
        const body = await (await authFetch('/admin/api/preset', ownerTok)).json() as any;
        expect(body.name).toBe('My Team');
      });

      it('bind=0.0.0.0이면 요청 Host 헤더의 호스트명을 endpoint host로 사용', async () => {
        await post('/admin/api/server-settings', ownerTok, { exposure: 'lan' });
        const r = await authFetch('/admin/api/preset', ownerTok); // fetch가 Host: 127.0.0.1:<port>를 보낸다
        const body = await r.json() as any;
        expect(body.endpoint).toBe('ws://127.0.0.1:47800');
      });
    });
  });
});
