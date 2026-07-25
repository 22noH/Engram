import chokidar, { FSWatcher } from 'chokidar';
import * as path from 'path';
import { FolderImportConfig, IMPORT_CONFIG_FILE, importTriggerPath, loadImportConfig } from './import.config';
import { FolderImporter } from './folder-importer';

// 감시 폴더 워처. rag/wiki-watcher.ts와 같은 chokidar 관례를 따르되 성격이 달라 별도 모듈이다
// (저건 "이미 위키인 것"을 재색인, 이건 "아직 위키가 아닌 것"을 변환).
//
// 워처가 보는 것 세 가지:
//   1) 감시 폴더 — 파일이 들어오면 디바운스 후 스캔
//   2) config/folder-import.json — 설정창에서 저장하면 재시작 없이 즉시 반영(폴더 변경·끄기 포함)
//   3) state/folder-import.trigger — 설정창의 "지금 검사" 버튼(자식 프로세스 IPC를 새로 만들지 않는다)

/** 파일 복사가 끝나기 전에 읽지 않도록 넉넉히 기다린다(윈도우 파일 잠금·연속 쓰기 흡수). */
const DEBOUNCE_MS = 3000;
/** 워처가 이벤트를 놓쳐도(네트워크 드라이브 등) 결국 처리되도록 하는 안전망 주기. */
const SWEEP_MS = 10 * 60 * 1000;

export class ImportWatcher {
  private configWatcher?: FSWatcher;
  private folderWatcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private sweep?: NodeJS.Timeout;
  private cfg: FolderImportConfig;
  private watchedFolder = '';
  private stopped = false;

  constructor(
    private readonly configDir: string,
    private readonly stateDir: string,
    private readonly importer: FolderImporter,
    private readonly log: (level: 'log' | 'warn' | 'error', msg: string) => void,
    private readonly debounceMs = DEBOUNCE_MS,
  ) {
    this.cfg = loadImportConfig(configDir);
  }

  async start(): Promise<void> {
    this.stopped = false;
    // 설정 파일과 트리거 파일만 본다. 아직 없는 파일도 chokidar가 생성 시점에 잡아준다.
    this.configWatcher = chokidar.watch(
      [path.join(this.configDir, IMPORT_CONFIG_FILE), importTriggerPath(this.stateDir)],
      { ignoreInitial: true },
    );
    this.configWatcher
      .on('add', (f) => this.onControlFile(f))
      .on('change', (f) => this.onControlFile(f));

    await this.applyConfig();
    this.sweep = setInterval(() => this.schedule(0), SWEEP_MS);
    this.sweep.unref?.();
    // 부팅 직후 1회 — 앱이 꺼져 있는 동안 폴더에 쌓인 파일을 처리한다.
    this.schedule(this.debounceMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.sweep) clearInterval(this.sweep);
    this.timer = undefined;
    this.sweep = undefined;
    await this.configWatcher?.close().catch(() => undefined);
    await this.folderWatcher?.close().catch(() => undefined);
    this.configWatcher = undefined;
    this.folderWatcher = undefined;
  }

  /** 현재 적용 중인 설정(테스트·상태 조회용). */
  config(): FolderImportConfig {
    return this.cfg;
  }

  private onControlFile(file: string): void {
    if (path.basename(file) === IMPORT_CONFIG_FILE) {
      void this.applyConfig().catch((e) => this.log('warn', `가져오기 설정 반영 실패: ${String(e)}`));
      return;
    }
    this.schedule(0); // 트리거 = "지금 검사"
  }

  /** 설정을 다시 읽고 폴더 워처를 붙이거나 뗀다. never-throw. */
  private async applyConfig(): Promise<void> {
    this.cfg = loadImportConfig(this.configDir);
    const want = this.cfg.enabled ? this.cfg.folder : '';
    if (want === this.watchedFolder) return;

    await this.folderWatcher?.close().catch(() => undefined);
    this.folderWatcher = undefined;
    this.watchedFolder = want;
    if (!want) {
      this.log('log', '폴더 자동 변환 비활성');
      return;
    }
    try {
      // 폴더가 아직 없을 수도 있다 — chokidar는 생기면 잡는다(만들지는 않는다, 사용자 폴더이므로).
      this.folderWatcher = chokidar.watch(want, { ignoreInitial: true, depth: 6 });
      this.folderWatcher
        .on('add', () => this.schedule(this.debounceMs))
        .on('change', () => this.schedule(this.debounceMs))
        .on('error', (e) => this.log('warn', `폴더 감시 오류: ${String(e)}`));
      this.log('log', `폴더 자동 변환 감시 시작: ${want}`);
      this.schedule(this.debounceMs); // 폴더가 바뀌었으니 새 폴더를 한 번 훑는다
    } catch (e) {
      this.log('warn', `폴더 감시 시작 실패: ${String(e)}`);
    }
  }

  /** 연속 이벤트를 한 번의 스캔으로 모은다. */
  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, delay);
    this.timer.unref?.();
  }

  /**
   * 스캔 1회. 절대 throw하지 않는다(워처가 죽으면 기능 전체가 조용히 멈춘다).
   * 매번 설정을 다시 읽는다 — chokidar가 설정 변경 이벤트를 놓쳐도(초기 스캔 중 저장, 네트워크
   * 드라이브 등) 다음 스캔에서 반드시 최신 설정으로 돈다. 작은 JSON 하나라 비용은 무시할 만하다.
   */
  async run(): Promise<void> {
    try {
      await this.applyConfig();
      const r = await this.importer.runOnce(this.cfg);
      if (r.processed || r.failed || r.skipped || r.pending) {
        this.log(
          'log',
          `폴더 가져오기: 처리 ${r.processed} · 건너뜀 ${r.skipped} · 실패 ${r.failed} · 대기 ${r.pending}`,
        );
      }
    } catch (e) {
      this.log('error', `폴더 가져오기 실행 실패: ${String(e)}`);
    }
  }
}
