import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ImportLedger, ImportRecord, MAX_ATTEMPTS, needsProcessing, unchangedByStat } from './import-ledger';

function rec(over: Partial<ImportRecord> = {}): ImportRecord {
  return { rel: 'a.md', name: 'a.md', size: 10, mtimeMs: 1000, hash: 'h1', status: 'done', ts: '2026-07-25T00:00:00.000Z', ...over };
}

describe('재처리 방지 판정', () => {
  it('기록이 없으면 처리한다', () => {
    expect(needsProcessing(undefined, { size: 10, mtimeMs: 1000 })).toBe(true);
  });

  it('내용·크기·시각이 그대로면 다시 처리하지 않는다(앱 재시작마다 재변환 금지)', () => {
    expect(needsProcessing(rec(), { size: 10, mtimeMs: 1000, hash: 'h1' })).toBe(false);
  });

  it('크기가 달라지면 처리한다', () => {
    expect(needsProcessing(rec(), { size: 11, mtimeMs: 1000, hash: 'h1' })).toBe(true);
  });

  it('해시가 달라지면(=파일이 실제로 바뀌면) 다시 처리한다', () => {
    expect(needsProcessing(rec(), { size: 10, mtimeMs: 1000, hash: 'h2' })).toBe(true);
  });

  it('내용은 같은데 mtime만 흔들린 touch는 재처리하지 않는다(비용)', () => {
    expect(needsProcessing(rec(), { size: 10, mtimeMs: 9999, hash: 'h1' })).toBe(false);
  });

  it('해시를 모르면 mtime으로 판정한다', () => {
    expect(needsProcessing(rec({ hash: undefined }), { size: 10, mtimeMs: 1000 })).toBe(false);
    expect(needsProcessing(rec({ hash: undefined }), { size: 10, mtimeMs: 2000 })).toBe(true);
  });

  it('건너뛴 파일은 내용이 그대로면 다시 시도하지 않는다', () => {
    expect(needsProcessing(rec({ status: 'skipped', reason: 'unsupported' }), { size: 10, mtimeMs: 1000, hash: 'h1' })).toBe(false);
  });

  it('대기(pending)는 항상 다음 스캔이 이어받는다', () => {
    expect(needsProcessing(rec({ status: 'pending' }), { size: 10, mtimeMs: 1000, hash: 'h1' })).toBe(true);
  });

  it('실패는 상한까지만 재시도한다(비용 폭주 방지)', () => {
    expect(needsProcessing(rec({ status: 'failed', attempts: 1 }), { size: 10, mtimeMs: 1000, hash: 'h1' })).toBe(true);
    expect(needsProcessing(rec({ status: 'failed', attempts: MAX_ATTEMPTS }), { size: 10, mtimeMs: 1000, hash: 'h1' })).toBe(false);
  });
});

describe('unchangedByStat — 해시 계산 전 1차 관문', () => {
  it('크기·시각이 같고 완료 상태면 해시조차 안 본다', () => {
    expect(unchangedByStat(rec(), { size: 10, mtimeMs: 1000 })).toBe(true);
  });
  it('기록 없음·대기·재시도 여지 있는 실패는 통과시킨다', () => {
    expect(unchangedByStat(undefined, { size: 10, mtimeMs: 1000 })).toBe(false);
    expect(unchangedByStat(rec({ status: 'pending' }), { size: 10, mtimeMs: 1000 })).toBe(false);
    expect(unchangedByStat(rec({ status: 'failed', attempts: 1 }), { size: 10, mtimeMs: 1000 })).toBe(false);
  });
  it('시각이 다르면 통과시킨다', () => {
    expect(unchangedByStat(rec(), { size: 10, mtimeMs: 2000 })).toBe(false);
  });
});

describe('ImportLedger 영속', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-ledger-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('저장한 기록을 다시 읽는다', async () => {
    const file = path.join(dir, 'folder-import.json');
    const l = new ImportLedger(file);
    await l.load();
    await l.put(rec({ rel: 'notes/a.md', pages: ['a-page'] }));
    const l2 = new ImportLedger(file);
    await l2.load();
    expect(l2.get('notes/a.md')?.pages).toEqual(['a-page']);
  });

  it('깨진 상태 파일은 빈 이력으로 시작한다(never-throw)', async () => {
    const file = path.join(dir, 'folder-import.json');
    fs.writeFileSync(file, '{not json');
    const l = new ImportLedger(file);
    await expect(l.load()).resolves.toBeUndefined();
    expect(l.all()).toEqual([]);
  });

  it('쓰기 실패를 삼킨다(디렉터리 대신 파일 경로가 막혀도 죽지 않는다)', async () => {
    const l = new ImportLedger(path.join(dir, 'a.md', 'nope.json')); // a.md는 파일이라 mkdir 실패
    fs.writeFileSync(path.join(dir, 'a.md'), 'x');
    await l.load();
    await expect(l.put(rec())).resolves.toBeUndefined();
  });

  it('최근 처리 목록은 시각 내림차순이고 상한만큼 보존한다', async () => {
    const l = new ImportLedger(path.join(dir, 'f.json'), 2);
    await l.load();
    await l.put(rec({ rel: 'a', ts: '2026-07-01T00:00:00.000Z' }));
    await l.put(rec({ rel: 'b', ts: '2026-07-03T00:00:00.000Z' }));
    await l.put(rec({ rel: 'c', ts: '2026-07-02T00:00:00.000Z' }));
    expect(l.recent().map((r) => r.rel)).toEqual(['b', 'c']); // a는 상한(2)에 밀려 잘림
  });

  it('상태별 개수를 센다(설정창 "3건 완료 · 1건 대기")', async () => {
    const l = new ImportLedger(path.join(dir, 'f.json'));
    await l.load();
    await l.put(rec({ rel: 'a', status: 'done' }));
    await l.put(rec({ rel: 'b', status: 'done' }));
    await l.put(rec({ rel: 'c', status: 'pending' }));
    await l.put(rec({ rel: 'd', status: 'skipped' }));
    expect(l.counts()).toEqual({ done: 2, skipped: 1, failed: 0, pending: 1 });
  });
});
