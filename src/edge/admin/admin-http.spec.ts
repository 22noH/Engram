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
  let dir: string; let distDir: string;
  let accounts: AccountStore; let sessions: SessionStore; let chat: ChatStore; let groups: GroupStore;
  let wikiPages: unknown[]; let pending: unknown[];
  let server: http.Server; let base: string;

  function startServer(overrides: Partial<AdminHttpDeps> = {}) {
    const deps: AdminHttpDeps = {
      accounts, sessions, chat, groups,
      wiki: { listPages: async () => wikiPages } as any,
      proposals: { listPending: async () => pending } as any,
      distDir,
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
});
