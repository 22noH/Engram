import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FolderImporter, ImporterPorts } from './folder-importer';
import { ImportLedger } from './import-ledger';
import { ImportWatcher } from './import-watcher';
import { saveImportConfig, touchImportTrigger } from './import.config';

// 워처는 chokidar를 쓰므로 이벤트 타이밍에 의존한다 — 여기서는 "설정을 다시 읽는가",
// "트리거로 스캔이 도는가", "스캔 실패가 워처를 죽이지 않는가"만 못박는다(감시 자체는 chokidar 책임).

function idleWait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('ImportWatcher', () => {
  let root: string;
  let configDir: string;
  let stateDir: string;
  let inbox: string;
  let watcher: ImportWatcher | undefined;
  let runs: number;
  let importer: FolderImporter;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-watch-'));
    configDir = path.join(root, 'config');
    stateDir = path.join(root, 'state');
    inbox = path.join(root, 'inbox');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(inbox, { recursive: true });
    runs = 0;
    const ports = {
      listFiles: async () => { runs++; return []; },
      hashFile: async () => 'h',
      extract: async () => ({ skip: true as const, reason: 'unsupported' }),
      organize: async () => ({ text: '' }),
      findRelated: async () => [],
      pageExists: async () => false,
      propose: async () => 'p',
      publishNow: async () => undefined,
      now: () => new Date(),
      log: () => undefined,
    } satisfies ImporterPorts;
    importer = new FolderImporter(ports, new ImportLedger(path.join(stateDir, 'l.json')));
  });

  afterEach(async () => {
    await watcher?.stop();
    watcher = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('꺼진 설정이면 스캔이 아무 일도 하지 않는다', async () => {
    saveImportConfig(configDir, { enabled: false, folder: inbox });
    watcher = new ImportWatcher(configDir, stateDir, importer, () => undefined, 5);
    await watcher.start();
    await watcher.run();
    expect(runs).toBe(0);
  });

  it('켜진 설정이면 스캔이 폴더를 훑는다', async () => {
    saveImportConfig(configDir, { enabled: true, folder: inbox });
    watcher = new ImportWatcher(configDir, stateDir, importer, () => undefined, 5);
    await watcher.start();
    await watcher.run();
    expect(runs).toBeGreaterThanOrEqual(1);
  });

  it('설정 파일이 바뀌면 재시작 없이 반영한다(감시 이벤트를 놓쳐도 다음 스캔이 최신 설정으로 돈다)', async () => {
    saveImportConfig(configDir, { enabled: false, folder: inbox });
    watcher = new ImportWatcher(configDir, stateDir, importer, () => undefined, 5);
    await watcher.start();
    expect(watcher.config().enabled).toBe(false);

    saveImportConfig(configDir, { enabled: true, folder: inbox, mode: 'raw' });
    await watcher.run();
    expect(watcher.config()).toMatchObject({ enabled: true, mode: 'raw' });
    expect(runs).toBeGreaterThanOrEqual(1);
  }, 15_000);

  it('감시 이벤트로도 설정이 반영된다', async () => {
    saveImportConfig(configDir, { enabled: false, folder: inbox });
    watcher = new ImportWatcher(configDir, stateDir, importer, () => undefined, 5);
    await watcher.start();
    await idleWait(300); // chokidar 초기 스캔이 끝난 뒤 저장(실사용 타이밍)
    saveImportConfig(configDir, { enabled: true, folder: inbox });
    for (let i = 0; i < 60 && !watcher.config().enabled; i++) await idleWait(50);
    expect(watcher.config().enabled).toBe(true);
  }, 15_000);

  it('"지금 검사" 트리거가 스캔을 깨운다', async () => {
    saveImportConfig(configDir, { enabled: true, folder: inbox });
    watcher = new ImportWatcher(configDir, stateDir, importer, () => undefined, 5);
    await watcher.start();
    const before = runs;
    touchImportTrigger(stateDir);
    for (let i = 0; i < 40 && runs <= before; i++) await idleWait(50);
    expect(runs).toBeGreaterThan(before);
  }, 15_000);

  it('스캔이 터져도 워처는 죽지 않는다', async () => {
    saveImportConfig(configDir, { enabled: true, folder: inbox });
    const boom = { runOnce: async () => { throw new Error('boom'); } } as unknown as FolderImporter;
    const logs: string[] = [];
    watcher = new ImportWatcher(configDir, stateDir, boom, (_l, m) => logs.push(m), 5);
    await watcher.start();
    await expect(watcher.run()).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes('실행 실패'))).toBe(true);
  });

  it('stop 후에는 타이머가 남지 않는다(jest 핸들 누수 방지)', async () => {
    saveImportConfig(configDir, { enabled: true, folder: inbox });
    watcher = new ImportWatcher(configDir, stateDir, importer, () => undefined, 5);
    await watcher.start();
    await expect(watcher.stop()).resolves.toBeUndefined();
    await expect(watcher.stop()).resolves.toBeUndefined(); // 두 번 불러도 안전
  });
});
