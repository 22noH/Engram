import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { PathResolver } from '../pal/path-resolver';
import { getCommandMode } from '../desktop/permissions-file';
import { readPresetFile } from '../desktop/preset-file';
import { AccountStore } from './auth/account-store';
import { GroupStore } from './auth/group-store';
import { ChatStore } from './messenger/chat-store';
import {
  dirSizeBytes, runConfigGet, runConfigSet, runGroupCreate, runGroupDelete, runGroupList,
  runGroupSetChannels, runGroupSetPerms, runPresetExport, runSetup, runStatus, runUserActivate, runUserApprove,
  runUserList, runUserResetPassword, runUserSuspend,
} from './server-admin';

// listening 프로브 테스트용: 방금 닫은 포트를 재사용 — 실제 개발 머신엔 흔히 다른 프로세스가
// 뭔가를 띄워두고 있어(예: 실행 중인 Engram 인스턴스) 기본 포트(47800) 고정 가정은 비결정적이다.
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

describe('server-admin', () => {
  let dir: string;
  let paths: PathResolver;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-server-admin-'));
    paths = new PathResolver(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  describe('runStatus', () => {
    it('빈 데이터 디렉터리: memberCount 0·heartbeat null·bytes 0·listening false', async () => {
      // 기본 포트(47800)가 이 머신에서 실제로 사용 중일 수 있어(다른 Engram 인스턴스 등) 방금
      // 닫은 빈 포트를 명시적으로 지정해 listening=false를 결정적으로 검증한다.
      const freePort = await getFreePort();
      fs.mkdirSync(paths.getConfigDir(), { recursive: true });
      fs.writeFileSync(path.join(paths.getConfigDir(), 'chat.json'), JSON.stringify({ port: freePort }));
      const s = await runStatus(paths);
      expect(s.memberCount).toBe(0);
      expect(s.lastHeartbeatMs).toBeNull();
      expect(s.chatBytes).toBe(0);
      expect(s.knowledgeBytes).toBe(0);
      expect(s.listening).toBe(false);
      // channelCount: ChatStore.listChannels()는 목록이 비어있으면 'general'을 자동 생성한다
      // (chat-store.ts:148, admin-http.ts getStatus와 동일한 관용) — 그래서 0이 아니라 1.
      expect(s.channelCount).toBe(1);
    });

    it('heartbeat 파일이 있으면 그 값을 ms로 반환', async () => {
      const stateDir = paths.getStateDir();
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'heartbeat'), '1700000000000');
      const s = await runStatus(paths);
      expect(s.lastHeartbeatMs).toBe(1700000000000);
    });

    it('읽기 전용: 실행 중 서버의 /clear 되돌리기 백업(.cleared)을 지우지 않는다(리뷰 지적 데이터 손실 가드)', async () => {
      // status는 데이터 폴더를 공유하는 실행 중 서버의 undo 백업을 절대 건드리면 안 된다.
      const chatDir = path.join(paths.getStateDir(), 'chat');
      fs.mkdirSync(chatDir, { recursive: true });
      const backup = path.join(chatDir, 'somechannel.jsonl.cleared');
      fs.writeFileSync(backup, '{"id":"m1","text":"undoable","ts":"2026-01-01T00:00:00Z"}\n');
      await runStatus(paths);
      expect(fs.existsSync(backup)).toBe(true); // status 호출 후에도 백업 보존(ChatStore readOnly)
    });

    it('손상된 heartbeat 파일은 null(숫자 아님)', async () => {
      const stateDir = paths.getStateDir();
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'heartbeat'), 'not-a-number');
      const s = await runStatus(paths);
      expect(s.lastHeartbeatMs).toBeNull();
    });

    it('chat 메시지를 넣으면 chatBytes>0·채널 수가 반영된다', async () => {
      const chat = new ChatStore(path.join(paths.getStateDir(), 'chat'));
      chat.listChannels(); // general 생성
      chat.createChannel('dev');
      chat.appendMessage('general', { authorId: 'owner', text: 'hello' });
      const s = await runStatus(paths);
      expect(s.chatBytes).toBeGreaterThan(0);
      expect(s.chatBytes).toBe(chat.historyBytes());
      expect(s.channelCount).toBe(2); // general + dev
    });

    it('memberCount는 accounts.list().length와 일치', async () => {
      const accounts = new AccountStore(paths.getStateDir());
      accounts.createPassword('kim', 'pw12345', 'Kim', { role: 'owner', status: 'active' });
      accounts.createPassword('lee', 'pw12345', 'Lee', { role: 'member', status: 'pending' });
      const s = await runStatus(paths);
      expect(s.memberCount).toBe(2);
    });

    it('knowledgeBytes=wiki+rag 디렉터리 총 바이트(하위 폴더 포함)', async () => {
      fs.mkdirSync(path.join(paths.getWikiDir(), 'pages'), { recursive: true });
      fs.writeFileSync(path.join(paths.getWikiDir(), 'pages', 'a.md'), '12345'); // 5바이트
      fs.mkdirSync(paths.getRagDir(), { recursive: true });
      fs.writeFileSync(path.join(paths.getRagDir(), 'index.bin'), '1234567'); // 7바이트
      const s = await runStatus(paths);
      expect(s.knowledgeBytes).toBe(12);
    });

    it('listening: 그 포트에 실제 리스너가 있으면 true', async () => {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as net.AddressInfo).port;
      fs.mkdirSync(paths.getConfigDir(), { recursive: true });
      fs.writeFileSync(path.join(paths.getConfigDir(), 'chat.json'), JSON.stringify({ port }));
      try {
        const s = await runStatus(paths);
        expect(s.listening).toBe(true);
      } finally {
        server.close();
      }
    });
  });

  describe('runSetup', () => {
    it('계정 0개: 코드 생성·alreadyConfigured false', () => {
      const r = runSetup(paths);
      expect(r.code).toBeTruthy();
      expect(r.alreadyConfigured).toBe(false);
      expect(r.consoleUrl).toContain('/admin');
    });

    it('재호출: 같은 코드를 반환(1회성 재발급 방지)', () => {
      const r1 = runSetup(paths);
      const r2 = runSetup(paths);
      expect(r2.code).toBe(r1.code);
    });

    it('owner 계정을 만든 뒤: alreadyConfigured true·코드는 null(새로 만들지 않음)', () => {
      const accounts = new AccountStore(paths.getStateDir());
      accounts.createPassword('kim', 'pw12345', 'Kim', { role: 'owner', status: 'active' });
      const r = runSetup(paths);
      expect(r.alreadyConfigured).toBe(true);
      expect(r.code).toBeNull();
    });

    it('bind=0.0.0.0은 콘솔 안내에서 localhost로 치환', () => {
      fs.mkdirSync(paths.getConfigDir(), { recursive: true });
      fs.writeFileSync(path.join(paths.getConfigDir(), 'chat.json'), JSON.stringify({ bind: '0.0.0.0', port: 47800 }));
      const r = runSetup(paths);
      expect(r.consoleUrl).toBe('http://localhost:47800/admin');
    });
  });

  describe('dirSizeBytes', () => {
    it('없는 디렉터리는 0', () => {
      expect(dirSizeBytes(path.join(dir, 'does-not-exist'))).toBe(0);
    });

    it('파일을 재귀적으로 합산', () => {
      const sub = path.join(dir, 'a', 'b');
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(dir, 'a', 'x.txt'), '12345'); // 5
      fs.writeFileSync(path.join(sub, 'y.txt'), '1234567'); // 7
      expect(dirSizeBytes(path.join(dir, 'a'))).toBe(12);
    });
  });

  // ── S5 Task 2: user·group·config·preset ──────────────────────────────────────────────────

  describe('user', () => {
    it('pending → approve → active', () => {
      const accounts = new AccountStore(paths.getStateDir());
      const created = accounts.createPassword('kim', 'pw12345', 'Kim', { role: 'member', status: 'pending' });
      const r = runUserApprove(paths, created.id);
      expect(r.ok).toBe(true);
      expect(accounts.get(created.id)?.status).toBe('active');
    });

    it('approve: pending이 아니면 거부하고 상태를 바꾸지 않는다', () => {
      const accounts = new AccountStore(paths.getStateDir());
      const created = accounts.createPassword('lee', 'pw12345', 'Lee', { role: 'member', status: 'active' });
      const r = runUserApprove(paths, created.id);
      expect(r.ok).toBe(false);
      expect(r.message).toContain('active');
      expect(accounts.get(created.id)?.status).toBe('active'); // 불변
    });

    it('suspend: active → suspended', () => {
      const accounts = new AccountStore(paths.getStateDir());
      const created = accounts.createPassword('park', 'pw12345', 'Park', { role: 'member', status: 'active' });
      const r = runUserSuspend(paths, created.id);
      expect(r.ok).toBe(true);
      expect(accounts.get(created.id)?.status).toBe('suspended');
    });

    it('activate: suspended → active(정지 되돌리기 — 리뷰 지적 일방통행 해소)', () => {
      const accounts = new AccountStore(paths.getStateDir());
      const created = accounts.createPassword('seo', 'pw12345', 'Seo', { role: 'member', status: 'suspended' });
      const r = runUserActivate(paths, created.id);
      expect(r.ok).toBe(true);
      expect(accounts.get(created.id)?.status).toBe('active');
    });

    it('activate: 이미 active면 ok=false(명확한 안내)', () => {
      const accounts = new AccountStore(paths.getStateDir());
      const created = accounts.createPassword('yoon', 'pw12345', 'Yoon', { role: 'member', status: 'active' });
      expect(runUserActivate(paths, created.id).ok).toBe(false);
    });

    it('suspend가 마지막 활성 owner면 경고 문구+activate 복구 안내(잠금 표면화)', () => {
      const accounts = new AccountStore(paths.getStateDir());
      const owner = accounts.createPassword('boss', 'pw12345', 'Boss', { role: 'owner', status: 'active' });
      const r = runUserSuspend(paths, owner.id);
      expect(r.ok).toBe(true); // 막지는 않음(로컬 관리자 신뢰)
      expect(r.message).toContain('마지막 활성 owner');
      expect(r.message).toContain('activate');
      // activate로 실제 복구 가능
      expect(runUserActivate(paths, owner.id).ok).toBe(true);
      expect(accounts.get(owner.id)?.status).toBe('active');
    });

    it('reset-password: 비어있지 않은 임시 비번을 반환하고 실제로 로그인 비번이 바뀐다', () => {
      const accounts = new AccountStore(paths.getStateDir());
      const created = accounts.createPassword('choi', 'oldpassword', 'Choi', { role: 'member', status: 'active' });
      const r = runUserResetPassword(paths, created.id);
      expect(r.ok).toBe(true);
      expect(r.tempPassword).toBeTruthy();
      expect(r.tempPassword!.length).toBeGreaterThan(0);
      // 옛 비번은 더는 통과하지 않고, 새 임시 비번은 통과한다(setPassword가 실제로 반영됐는지 검증).
      expect(accounts.verifyPassword('choi', 'oldpassword')).toBeNull();
      expect(accounts.verifyPassword('choi', r.tempPassword!)?.id).toBe(created.id);
    });

    it('없는 id: approve/suspend/reset-password 전부 명확한 에러(ok=false)', () => {
      expect(runUserApprove(paths, 'no-such-id').ok).toBe(false);
      expect(runUserSuspend(paths, 'no-such-id').ok).toBe(false);
      const r = runUserResetPassword(paths, 'no-such-id');
      expect(r.ok).toBe(false);
      expect(r.tempPassword).toBeUndefined();
    });

    it('list: id·loginId·displayName·role·status를 반환', () => {
      const accounts = new AccountStore(paths.getStateDir());
      accounts.createPassword('a1', 'pw12345', 'A One', { role: 'owner', status: 'active' });
      accounts.createPassword('a2', 'pw12345', 'A Two', { role: 'member', status: 'pending' });
      const list = runUserList(paths);
      expect(list).toHaveLength(2);
      expect(list.map((u) => u.loginId).sort()).toEqual(['a1', 'a2']);
      expect(list[0]).toHaveProperty('role');
      expect(list[0]).toHaveProperty('status');
    });
  });

  describe('group', () => {
    it('create → list에 반영', () => {
      const r = runGroupCreate(paths, 'Engineers');
      expect(r.ok).toBe(true);
      expect(r.group?.name).toBe('Engineers');
      const list = runGroupList(paths);
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('Engineers');
    });

    it('delete: 존재하면 제거하고 ok=true, 없으면 ok=false', () => {
      const created = runGroupCreate(paths, 'Temp').group!;
      expect(runGroupDelete(paths, created.id).ok).toBe(true);
      expect(runGroupList(paths)).toHaveLength(0);
      expect(runGroupDelete(paths, created.id).ok).toBe(false); // 이미 지워짐
    });

    it('set-perms: 잘못된 권한이 섞이면 전부 거부(부분 적용 없음)', () => {
      const created = runGroupCreate(paths, 'Reviewers').group!;
      const r = runGroupSetPerms(paths, created.id, ['wiki.approve', 'not.a.real.perm']);
      expect(r.ok).toBe(false);
      const groups = new GroupStore(paths.getStateDir());
      expect(groups.get(created.id)?.permissions).toEqual([]); // 부분 적용 안 됨
    });

    it('set-perms: 화이트리스트 안 권한은 저장된다', () => {
      const created = runGroupCreate(paths, 'Approvers').group!;
      const r = runGroupSetPerms(paths, created.id, ['wiki.approve', 'wiki.edit']);
      expect(r.ok).toBe(true);
      const groups = new GroupStore(paths.getStateDir());
      expect(groups.get(created.id)?.permissions.sort()).toEqual(['wiki.approve', 'wiki.edit']);
    });

    it('set-channels: 채널 id 목록을 저장', () => {
      const created = runGroupCreate(paths, 'DevChannel').group!;
      const r = runGroupSetChannels(paths, created.id, ['dev', 'general']);
      expect(r.ok).toBe(true);
      const groups = new GroupStore(paths.getStateDir());
      expect(groups.get(created.id)?.channelIds.sort()).toEqual(['dev', 'general']);
    });
  });

  describe('config', () => {
    it('get: 미설정 상태의 기본값(port 47800·bind 127.0.0.1·retention unlimited·autoCompact true·coding auto)', () => {
      const c = runConfigGet(paths);
      expect(c.port).toBe(47800);
      expect(c.bind).toBe('127.0.0.1');
      expect(c.retention).toEqual({ mode: 'unlimited' });
      expect(c.autoCompact).toBe(true);
      expect(c.codingMode).toBe('auto');
    });

    it('set port: 유효값 저장 후 get으로 왕복, 무효값(0·범위 밖·비숫자) 거부', () => {
      expect(runConfigSet(paths, 'port', '8080').ok).toBe(true);
      expect(runConfigGet(paths).port).toBe(8080);
      expect(runConfigSet(paths, 'port', '0').ok).toBe(false);
      expect(runConfigSet(paths, 'port', '99999').ok).toBe(false);
      expect(runConfigSet(paths, 'port', 'abc').ok).toBe(false);
      expect(runConfigGet(paths).port).toBe(8080); // 무효 시도 후에도 이전 유효값 보존
    });

    it('set bind: 화이트리스트(127.0.0.1/0.0.0.0)만 허용, 그 외 거부', () => {
      expect(runConfigSet(paths, 'bind', '0.0.0.0').ok).toBe(true);
      expect(runConfigGet(paths).bind).toBe('0.0.0.0');
      expect(runConfigSet(paths, 'bind', '10.0.0.5').ok).toBe(false);
      expect(runConfigSet(paths, 'bind', 'localhost').ok).toBe(false);
      expect(runConfigGet(paths).bind).toBe('0.0.0.0'); // 무효 시도 후에도 이전 유효값 보존
    });

    it('set retention: "count:2" 파싱 → {mode:count,value:2}, get으로 왕복', () => {
      expect(runConfigSet(paths, 'retention', 'count:2').ok).toBe(true);
      expect(runConfigGet(paths).retention).toEqual({ mode: 'count', value: 2 });
    });

    it('set retention: "days:90" 파싱 → {mode:days,value:90}', () => {
      expect(runConfigSet(paths, 'retention', 'days:90').ok).toBe(true);
      expect(runConfigGet(paths).retention).toEqual({ mode: 'days', value: 90 });
    });

    it('set retention: "unlimited" 파싱 → {mode:unlimited}', () => {
      runConfigSet(paths, 'retention', 'count:5');
      expect(runConfigSet(paths, 'retention', 'unlimited').ok).toBe(true);
      expect(runConfigGet(paths).retention).toEqual({ mode: 'unlimited' });
    });

    it('set retention: 잘못된 문법·음수/0·정수 아닌 count는 거부', () => {
      expect(runConfigSet(paths, 'retention', 'bogus').ok).toBe(false);
      expect(runConfigSet(paths, 'retention', 'count:0').ok).toBe(false);
      expect(runConfigSet(paths, 'retention', 'count:-5').ok).toBe(false);
      expect(runConfigSet(paths, 'retention', 'count:1.5').ok).toBe(false);
      expect(runConfigSet(paths, 'retention', 'days:0').ok).toBe(false);
    });

    it('set autoCompact: true/false 저장, 그 외 거부', () => {
      expect(runConfigSet(paths, 'autoCompact', 'false').ok).toBe(true);
      expect(runConfigGet(paths).autoCompact).toBe(false);
      expect(runConfigSet(paths, 'autoCompact', 'true').ok).toBe(true);
      expect(runConfigGet(paths).autoCompact).toBe(true);
      expect(runConfigSet(paths, 'autoCompact', 'yes').ok).toBe(false);
    });

    it('set coding: auto/allowlist/off 저장 후 getCommandMode·runConfigGet 양쪽에서 왕복, 그 외 거부', () => {
      expect(runConfigSet(paths, 'coding', 'allowlist').ok).toBe(true);
      expect(runConfigGet(paths).codingMode).toBe('allowlist');
      expect(getCommandMode(paths.getConfigDir())).toBe('allowlist');
      expect(runConfigSet(paths, 'coding', 'off').ok).toBe(true);
      expect(runConfigGet(paths).codingMode).toBe('off');
      expect(runConfigSet(paths, 'coding', 'bogus').ok).toBe(false);
    });

    it('알 수 없는 키는 거부', () => {
      expect(runConfigSet(paths, 'nope', 'x').ok).toBe(false);
    });

    it('port/bind/retention/autoCompact/coding 전부 재시작 후 적용(appliesAfterRestart=true) — fence는 부팅 시 한 번만 로드', () => {
      expect(runConfigSet(paths, 'port', '9090').appliesAfterRestart).toBe(true);
      expect(runConfigSet(paths, 'bind', '0.0.0.0').appliesAfterRestart).toBe(true);
      expect(runConfigSet(paths, 'retention', 'unlimited').appliesAfterRestart).toBe(true);
      expect(runConfigSet(paths, 'autoCompact', 'true').appliesAfterRestart).toBe(true);
      expect(runConfigSet(paths, 'coding', 'auto').appliesAfterRestart).toBe(true);
    });
  });

  describe('preset', () => {
    it('export: configDir/preset.json을 생성하고 name·endpoint를 포함', () => {
      const r = runPresetExport(paths);
      expect(r.ok).toBe(true);
      expect(fs.existsSync(path.join(paths.getConfigDir(), 'preset.json'))).toBe(true);
      expect(r.preset.name).toBeTruthy();
      expect(r.preset.endpoint).toMatch(/^ws:\/\//);
      const onDisk = readPresetFile(paths.getConfigDir());
      expect(onDisk).toEqual(r.preset);
    });

    it('export: 지정한 경로로 내보내면 그 경로에 파일이 생긴다', () => {
      const outPath = path.join(dir, 'exported', 'my-preset.json');
      const r = runPresetExport(paths, outPath);
      expect(r.ok).toBe(true);
      expect(r.path).toBe(outPath);
      expect(fs.existsSync(outPath)).toBe(true);
      const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      expect(written).toEqual(r.preset);
    });

    it('export: bind/port을 반영(saveChatBootConfig로 설정한 값이 preset endpoint에 반영)', () => {
      runConfigSet(paths, 'port', '5555');
      runConfigSet(paths, 'bind', '127.0.0.1');
      const r = runPresetExport(paths);
      expect(r.preset.endpoint).toBe('ws://127.0.0.1:5555');
    });
  });
});
