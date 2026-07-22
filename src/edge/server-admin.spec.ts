import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { PathResolver } from '../pal/path-resolver';
import { AccountStore } from './auth/account-store';
import { ChatStore } from './messenger/chat-store';
import { dirSizeBytes, runSetup, runStatus } from './server-admin';

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
});
