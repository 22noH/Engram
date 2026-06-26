import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ConversationStore } from './conversation-store';
import { PathResolver } from '../pal/path-resolver';

describe('ConversationStore', () => {
  let dir: string; let store: ConversationStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-conv-'));
    store = new ConversationStore(new PathResolver(dir));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('append한 레코드를 since(null)로 전부 읽는다', async () => {
    await store.append('default', { ts: '2026-06-26T01:00:00.000Z', question: 'q1', answer: 'a1' });
    await store.append('default', { ts: '2026-06-27T01:00:00.000Z', question: 'q2', answer: 'a2' });
    const all = await store.since('default', null);
    expect(all.map((r) => r.question)).toEqual(['q1', 'q2']); // 날짜 파일 경계 가로지름, 시간순
  });

  it('커서 이후만 반환한다', async () => {
    await store.append('default', { ts: '2026-06-26T01:00:00.000Z', question: 'old', answer: 'a' });
    await store.append('default', { ts: '2026-06-26T02:00:00.000Z', question: 'new', answer: 'a' });
    const recent = await store.since('default', '2026-06-26T01:30:00.000Z');
    expect(recent.map((r) => r.question)).toEqual(['new']);
  });

  it('대화 없으면 since는 빈 배열, readCursor는 null', async () => {
    expect(await store.since('default', null)).toEqual([]);
    expect(await store.readCursor('default')).toBeNull();
  });

  it('writeCursor→readCursor 라운드트립', async () => {
    await store.writeCursor('default', '2026-06-26T05:00:00.000Z');
    expect(await store.readCursor('default')).toBe('2026-06-26T05:00:00.000Z');
  });

  it('손상된 줄을 건너뛰고 나머지는 읽는다', async () => {
    // 정상 레코드 1개 append → 날짜 .jsonl 파일·디렉토리 생성됨
    await store.append('default', { ts: '2026-06-26T01:00:00.000Z', question: 'q1', answer: 'a1' });
    // 같은 파일에 크래시로 잘린 듯한 손상 줄 + 정상 레코드 1개를 직접 덧붙임
    const file = path.join(dir, 'state', 'conversations', 'default', '2026-06-26.jsonl');
    fs.appendFileSync(file, '{bad json\n');
    fs.appendFileSync(file, JSON.stringify({ ts: '2026-06-26T02:00:00.000Z', question: 'q2', answer: 'a2' }) + '\n');
    const all = await store.since('default', null);
    expect(all.map((r) => r.question)).toEqual(['q1', 'q2']); // 손상 줄은 건너뜀
  });
});
