// Electron 껍데기(스펙 §3): 트레이 상주 + 설정창 + 자식(상주 main.js) 감독. 로직은 테스트된 모듈에 위임.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray, utilityProcess } from 'electron';
import { execFileSync } from 'child_process';
import type { UtilityProcess } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { autoUpdater } from 'electron-updater';
import { readStatus } from './status';
import { Backoff, STABLE_UPTIME_MS, WARN_AFTER } from './backoff';
import { claudeInstallCommand, detectClaude, spawnRunner } from './claude-detect';
import { addOllamaProfile, detectOllama } from './ollama';
import { saveAnthropicApiKey } from './api-brain';
import { listBrains, setDefaultBrain, removeBrainProfile, slugFromModel, listBrainDetails, updateBrainProfile, BrainPatch } from './brains-file';
import { listMcpServersFile, addMcpServer, removeMcpServer, mirrorClaudeMcp } from './mcp-file';
import { readClaudeMcpServers } from '../brain/claude-mcp-import';
import { getCommandMode, setCommandMode, getPermissionDetails, setPermissionList, getMcpWriteMode, setMcpWriteMode } from './permissions-file';
import { setAlias, removeAlias, setSearchRoots } from './coderepos-file';
import { listSchedules, removeScheduleFromFile } from './schedules-file';
import { readWikiRemoteFile, saveWikiRemote, WikiRemoteForm } from './wiki-remote-file';
import { readPresetFile } from './preset-file';
import { loadCodeRepos } from '../agent-layer/coderepos';
import { saveDiscordToken } from './messenger-writer';
import { loadChatConfig } from '../edge/messenger/chat.config';
import { getChatRetention, setChatRetention } from './chat-retention-file';
import { resolveLanguage } from '../agent-layer/language';
import { loadLocalBrains, addLocalBrain } from './local-brains';
import { readSetupCode } from '../edge/auth/setup-code';
import { focusOrRestore } from './window-focus';
import { PtyManager } from './pty-manager';
import { diffStatus, diffFile } from './git-diff';
import { classifyHealth } from './health-identity';
import * as nodeHttp from 'http';
import { randomUUID } from 'crypto';

// T4(실측 검증) dev/test 격리: 설치판(트레이 상주, %APPDATA%/Engram 단일 인스턴스 락 보유)을
// 건드리지 않고 `electron .`을 별도 데이터로 띄우기 위한 훅. getPath('userData')·
// requestSingleInstanceLock보다 반드시 먼저 와야 한다. 운영 배포는 이 환경변수를 절대 설정하지
// 않으므로 회귀 없음.
if (process.env.ENGRAM_USERDATA_DIR) app.setPath('userData', process.env.ENGRAM_USERDATA_DIR);

const dataDir = app.getPath('userData'); // 예: %APPDATA%/Engram
const configDir = path.join(dataDir, 'config');
// 포트 피기백 가드(플랜 2026-07-24): 부팅마다 랜덤 id 1개 — 자식 헬스 응답과 대조해 "내가 방금 띄운
// 자식"인지 확인하는 재료. 자식이 죽어도 재시작(startChild)마다 새로 만들지 않고 이 프로세스 수명
// 동안 고정(같은 데스크톱 인스턴스가 재시작한 자식은 계속 같은 id를 쓰는 게 맞다).
const instanceId = randomUUID();
const childEnv = {
  ...process.env,
  ENGRAM_DATA_DIR: dataDir,
  ENGRAM_MODEL_CACHE_DIR: path.join(dataDir, 'models'),
  // 리뷰 지적: 데스크톱 백엔드는 /admin(서버 콘솔)을 절대 서빙하지 않는다 — 콘솔은 서버 에디션
  // 전용 물건. startChild(상주 main.js)·startLocalBrain(로컬 두뇌) 둘 다 이 childEnv를 물려받는다
  // — 로컬 두뇌엔 무해(brain 모드는 애초에 adminDeps 미배선). main.ts가 isServer && 이 값 !== '1'
  // 일 때만 adminDeps를 배선(src/main.ts), self.adapter.ts가 라우팅에서도 한 번 더 확인(방어 이중화).
  ENGRAM_DESKTOP: '1',
  // 포트 피기백 가드: 상주 child(startChild)만 폴링 대조 대상이라 실질적으로 쓰이는 건 그쪽뿐이지만,
  // ENGRAM_DESKTOP과 같은 결로 childEnv에 얹는다 — 로컬 두뇌(startLocalBrain)도 물려받아 헬스에
  // 에코하게 되지만 브레인은 애초에 main.ts에 헬스 폴링 루프가 없어(별도 감독 없음, ponytail) 아무도
  // 이 필드를 대조하지 않는다. 즉 additive·무해(회귀 0) — 브레인 부팅·감독 로직은 손대지 않았다.
  ENGRAM_INSTANCE_ID: instanceId,
};

let tray: Tray | null = null;
let settingsWin: BrowserWindow | null = null;
let chatWin: BrowserWindow | null = null;
let child: UtilityProcess | null = null;
let quitting = false;
let childStartedAt = 0;
const backoff = new Backoff();

// ---- 코드 패널 터미널(스펙: docs/superpowers/specs/2026-07-23-code-panel-design.md) ----
// 레포 첫 스트리밍 IPC 채널: pty 출력/종료를 chatWin으로 push(webContents.send).
const ptyManager = new PtyManager();
ptyManager.onData((sid, data) => {
  chatWin?.webContents.send('engram:pty-data', { sid, data });
});
ptyManager.onExit((sid, code) => {
  chatWin?.webContents.send('engram:pty-exit', { sid, code });
});

// UI 언어: 영어 기본, 시스템 로케일이 한국어면 한국어(렌더러는 navigator.language로 동일 판정).
const ko = (): boolean => app.getLocale().toLowerCase().startsWith('ko');
const T = {
  openChat: () => (ko() ? '채팅 열기' : 'Open Chat'),
  openSettings: () => (ko() ? '설정 열기' : 'Open Settings'),
  restart: () => (ko() ? '재시작' : 'Restart'),
  quit: () => (ko() ? '종료' : 'Quit'),
  warnTip: () => (ko() ? 'Engram — 재시작 반복 실패 (로그 확인)' : 'Engram — restarts failing repeatedly (check logs)'),
};

// ---- 자식(상주) 감독 ----
function startChild(): void {
  const entry = path.join(app.getAppPath(), 'dist', 'src', 'main.js');
  childStartedAt = Date.now();
  const lang = resolveLanguage(loadChatConfig(configDir).language, app.getLocale());
  child = utilityProcess.fork(entry, [], { env: { ...childEnv, ENGRAM_LANG: lang }, stdio: 'ignore', serviceName: 'engram-core' });
  child.on('exit', () => {
    child = null;
    if (quitting) return;
    // 충분히 살아있었으면 정상 운행 중 크래시로 보고 백오프 리셋.
    if (Date.now() - childStartedAt >= STABLE_UPTIME_MS) backoff.reset();
    const delay = backoff.next();
    updateTray();
    setTimeout(() => {
      if (!quitting && !child) startChild();
    }, delay);
  });
  updateTray();
}

function restartChild(): void {
  backoff.reset();
  if (child) {
    const c = child;
    child = null; // exit 핸들러의 자동재시작과 경합 방지: 먼저 끊고 직접 재시작
    c.removeAllListeners('exit');
    c.kill();
  }
  startChild();
}

// ---- 로컬 두뇌(+, 스펙 §2.1/§2.5) fork ----
// brain 모드: 계정/team/위키승인 미탑재, 127.0.0.1 고정(chat.config). ponytail: 죽어도 재시작 안 함
// — 감독을 상주 child만큼 복잡하게 만들 필요가 없다. 재시작하려면 앱을 재부팅하면 된다(다음 boot에서 다시 fork).
const brainProcs: UtilityProcess[] = [];
function startLocalBrain(b: { port: number; dataDir: string }): void {
  const entry = path.join(app.getAppPath(), 'dist', 'src', 'main.js');
  brainProcs.push(utilityProcess.fork(entry, [], {
    env: {
      ...childEnv,
      ENGRAM_DATA_DIR: b.dataDir, ENGRAM_MODEL_CACHE_DIR: path.join(dataDir, 'models'), // 모델 캐시는 메인과 공유(재다운로드 방지)
      ENGRAM_CHAT_ROLE: 'brain', ENGRAM_CHAT_PORT: String(b.port),
    },
    stdio: 'ignore', serviceName: 'engram-brain',
  }));
}

// ---- 트레이 ----
function trayIcon(): Electron.NativeImage {
  return nativeImage.createFromPath(path.join(app.getAppPath(), 'src', 'desktop', 'assets', 'tray.png'));
}

function updateTray(): void {
  if (!tray) return;
  const warn = backoff.consecutiveFails >= WARN_AFTER;
  tray.setToolTip(warn ? T.warnTip() : 'Engram');
}

function createTray(): void {
  tray = new Tray(trayIcon());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: T.openChat(), click: () => openChat() },
      { label: T.openSettings(), click: () => openSettings() },
      { label: T.restart(), click: () => restartChild() },
      { type: 'separator' },
      { label: T.quit(), click: () => app.quit() },
    ]),
  );
  tray.on('double-click', () => openChat());
  updateTray();
}

// ---- 설정창 ----
function openSettings(): void {
  if (settingsWin) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 760,
    height: 560,
    minWidth: 640,
    minHeight: 480,
    title: 'Engram 설정',
    icon: trayIcon(), // dev 모드 작업표시줄에 Electron 기본 로고 대신 뇌 아이콘
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  void settingsWin.loadFile(path.join(app.getAppPath(), 'src', 'desktop', 'settings.html'));
  settingsWin.on('closed', () => (settingsWin = null));
}

// ---- 채팅 창(Phase 9): 자식(상주)이 서빙하는 페이지를 그대로 로드 — 폰 브라우저와 단일 코드 경로 ----
// 자식이 리슨하기 전(첫 부팅 임베딩 로드 등)엔 빈 에러 페이지 대신 대기 화면을 띄우고,
// 메인 프로세스가 포트를 폴링해 준비되는 순간 채팅으로 진입한다(ERR_CONNECTION_REFUSED 노이즈 제거).
function openChat(): void {
  if (chatWin) {
    chatWin.focus();
    return;
  }
  const cfg = loadChatConfig(configDir, childEnv);
  const healthUrl = `http://127.0.0.1:${cfg.port}/`; // 준비 감지용(두뇌 http 헬스)
  const rendererIndex = path.join(app.getAppPath(), 'renderer', 'dist', 'index.html'); // 클라가 소유하는 페이지
  // 커스텀 타이틀바: 페이지 상단 바(#titlebar)가 드래그 영역, 창 버튼은 OS 오버레이.
  // 색은 시스템 라이트/다크를 따라감(페이지 팔레트와 동일 값).
  // Quiet Library 토큰 값(renderer/src/theme.css :root과 동일 — 여긴 CSS 밖이라 hex 복제 불가피).
  const overlay = (): Electron.TitleBarOverlay =>
    nativeTheme.shouldUseDarkColors
      ? { color: '#1f221f', symbolColor: '#e6e5df', height: 36 }
      : { color: '#fdfdfc', symbolColor: '#24292e', height: 36 };
  chatWin = new BrowserWindow({
    width: 980, height: 720, title: 'Engram',
    icon: trayIcon(), // dev 모드 작업표시줄에 Electron 기본 로고 대신 뇌 아이콘
    titleBarStyle: 'hidden', titleBarOverlay: overlay(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191b19' : '#f5f6f4',
    webPreferences: { preload: path.join(__dirname, 'chat-preload.js') },
  });
  const onTheme = (): void => {
    try { chatWin?.setTitleBarOverlay(overlay()); } catch { /* 미지원 플랫폼 무시 */ }
  };
  nativeTheme.on('updated', onTheme);
  // 메시지 속 링크(target=_blank)는 새 Electron 창 대신 기본 브라우저로.
  chatWin.webContents.setWindowOpenHandler(({ url: ext }) => {
    void shell.openExternal(ext);
    return { action: 'deny' };
  });
  // 렌더러(file://) 밖으로 나가는 네비게이션은 외부 브라우저로(창 탈취 방지).
  chatWin.webContents.on('will-navigate', (e, navUrl) => {
    if (!navUrl.startsWith('file://')) {
      e.preventDefault();
      void shell.openExternal(navUrl);
    }
  });
  const waiting = 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<style>body{background:#f5f6f4;color:#6b7268;font-family:system-ui;display:flex;' +
    'align-items:center;justify-content:center;height:100vh;margin:0}' +
    '@media(prefers-color-scheme:dark){body{background:#191b19;color:#9aa096}}</style>' +
    `<div>${ko() ? 'Engram 시작 중…' : 'Starting Engram…'}</div>`,
  );
  // 배포 프리셋(configDir/preset.json — `{name,endpoint}`): 있으면 렌더러 URL에 주입해
  // connections.ts seed()가 그 서버를 기본 연결로 시드하게 한다. 없으면 기존 local-only 그대로.
  // 읽기+기본이름 채움 로직은 preset-file.ts로 추출됨(서버 콘솔 S3 Task 2 — admin-http의
  // 프리셋 생성(buildPreset)과 셰이프를 공유, 동작 자체는 무변경).
  let preset = '';
  const p = readPresetFile(configDir);
  if (p) preset = `&presetName=${encodeURIComponent(p.name)}&presetEndpoint=${encodeURIComponent(p.endpoint)}`;
  // 포트 피기백 가드(플랜 2026-07-24): 헬스 응답 본문을 모아 classifyHealth로 대조한다.
  // 'ok'=우리 자식 → 로드. 'foreign'=다른 인스턴스가 이 포트에 이미 응답 중 → 폴링 즉시 중단하고
  // 명확한 실패(에러 다이얼로그+종료) — 조용히 남의 서버에 붙는 사고 방지. 'pending'=아직 못 믿을
  // 응답(파싱 실패·자식 미기동) → 기존과 동일하게 계속 폴링(타이밍 불변).
  const onForeignInstance = (): void => {
    dialog.showErrorBox(
      'Engram is already running',
      `Another instance of Engram is already using port ${cfg.port}. ` +
        'Close the other instance first, then start Engram again.',
    );
    app.quit();
  };
  // 부팅 타임아웃(실사고 2026-07-24): 좀비가 포트를 쥐고 응답을 안 하면 'pending'이 영원히 돌아
  // '시작 중'에 무한 대기했다. 상한을 넘으면 명확한 안내 후 종료. RAG 웜업으로 정상 부팅도
  // 1분을 넘길 수 있어 넉넉히 잡는다.
  const BOOT_TIMEOUT_MS = 120_000;
  const probeStart = Date.now();
  const onBootTimeout = (): void => {
    dialog.showErrorBox(
      'Engram could not start',
      `The server did not become ready on port ${cfg.port}. ` +
        'Another process may be holding the port, or the server failed to start. ' +
        'Quit any other Engram instances (check Task Manager) and try again.',
    );
    app.quit();
  };
  const retry = (): void => {
    if (Date.now() - probeStart > BOOT_TIMEOUT_MS) { onBootTimeout(); return; }
    setTimeout(probe, 2000);
  };
  const probe = (): void => {
    if (!chatWin) return; // 창 닫힘 = 폴링 중단
    let settled = false; // 타임아웃 destroy와 error가 겹쳐도 재시도는 한 번만(프로브 중복 스택 방지)
    const retryOnce = (): void => { if (settled) return; settled = true; retry(); };
    const req = nodeHttp.get(healthUrl, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => {
        if (!chatWin) return; // 응답 도착 사이 창이 닫혔으면 무시
        const status = classifyHealth(body, instanceId);
        if (status === 'foreign') { onForeignInstance(); return; }
        if (status === 'pending') { retryOnce(); return; }
        const lang = resolveLanguage(cfg.language, app.getLocale());
        void chatWin.loadFile(rendererIndex, { search: `port=${cfg.port}&lang=${lang}${preset}` }); // 헬스 ok → 클라 로드(포트·언어·프리셋 주입)
      });
      res.on('error', () => { retryOnce(); });
    });
    req.on('error', () => { retryOnce(); });
    // 좀비가 accept만 하고 응답을 안 하는 케이스(실관측) — 프로브 자체에 짧은 타임아웃.
    req.setTimeout(3000, () => { req.destroy(new Error('probe timeout')); });
  };
  // 로드 후 자식이 죽는 등 메인 프레임 로드가 실패하면 대기 화면으로 되돌리고 다시 폴링.
  chatWin.webContents.on('did-fail-load', (_e, _code, _desc, _url, isMainFrame) => {
    if (!isMainFrame || !chatWin) return;
    void chatWin.loadURL(waiting);
    setTimeout(probe, 2000);
  });
  chatWin.on('closed', () => {
    nativeTheme.removeListener('updated', onTheme);
    chatWin = null;
  });
  void chatWin.loadURL(waiting);
  probe();
}

// ---- IPC (로직은 테스트된 모듈 위임) ----
function registerIpc(): void {
  ipcMain.handle('engram:status', () => ({
    ...readStatus(dataDir, Date.now()),
    dataDir,
    childRunning: child !== null,
    // 경고 판정은 메인이 WARN_AFTER로 단일 계산 — 렌더러에 임계값 중복 없음.
    warn: backoff.consecutiveFails >= WARN_AFTER,
  }));
  ipcMain.handle('engram:detect-claude', async () => ({
    ...(await detectClaude(spawnRunner)),
    installCommand: claudeInstallCommand(process.platform),
  }));
  ipcMain.handle('engram:detect-ollama', () => detectOllama());
  ipcMain.handle('engram:add-ollama', (_e, model: string, name: string, setDefault: boolean) => {
    addOllamaProfile(configDir, model, name, setDefault);
  });
  ipcMain.handle('engram:save-token', (_e, token: string) => {
    saveDiscordToken(configDir, token);
  });
  ipcMain.handle('engram:save-api-key', (_e, apiKey: string, setDefault: boolean) => {
    saveAnthropicApiKey(configDir, apiKey, setDefault);
  });
  ipcMain.handle('engram:list-brains', () => listBrains(configDir));
  ipcMain.handle('engram:set-default-brain', (_e, key: string) => { setDefaultBrain(configDir, key); });
  ipcMain.handle('engram:remove-brain', (_e, key: string) => { removeBrainProfile(configDir, key); });
  ipcMain.handle('engram:slug-model', (_e, model: string) => slugFromModel(model));
  ipcMain.handle('engram:list-brain-details', () => listBrainDetails(configDir));
  ipcMain.handle('engram:update-brain-profile', (_e, key: string, patch: BrainPatch, newKey?: string) =>
    updateBrainProfile(configDir, key, patch, newKey));
  ipcMain.handle('engram:get-permission-details', () => getPermissionDetails(configDir));
  ipcMain.handle('engram:set-permission-list', (_e, field: 'writePaths' | 'denyPaths' | 'commands', values: string[] | null) => {
    setPermissionList(configDir, field, values);
  });
  ipcMain.handle('engram:get-coderepos', () => loadCodeRepos(configDir));
  ipcMain.handle('engram:set-code-alias', (_e, alias: string, targetPath: string) => setAlias(configDir, alias, targetPath));
  ipcMain.handle('engram:remove-code-alias', (_e, alias: string) => { removeAlias(configDir, alias); });
  ipcMain.handle('engram:set-search-roots', (_e, roots: string[]) => { setSearchRoots(configDir, roots); });
  // clear-compact Task 7: 개인앱은 로그인이 없어 서버 콘솔 admin-http API 대신 로컬 config를
  // 직접 조회/저장한다(chat-retention-file.ts에 위임 — 로직·검증은 거기서 테스트됨).
  ipcMain.handle('engram:get-chat-retention', () => getChatRetention(configDir));
  ipcMain.handle('engram:set-chat-retention', (_e, retention: unknown, autoCompact: unknown) => {
    setChatRetention(configDir, retention, autoCompact);
  });
  ipcMain.handle('engram:list-schedules', () => listSchedules(configDir));
  ipcMain.handle('engram:remove-schedule', (_e, id: string) => removeScheduleFromFile(configDir, id));
  ipcMain.handle('engram:get-wiki-remote', () => readWikiRemoteFile(configDir));
  ipcMain.handle('engram:set-wiki-remote', (_e, cfg: WikiRemoteForm) => { saveWikiRemote(configDir, cfg); });
  ipcMain.handle('engram:get-command-mode', () => getCommandMode(configDir));
  ipcMain.handle('engram:set-command-mode', (_e, mode: string) => { setCommandMode(configDir, mode as 'auto' | 'allowlist' | 'off'); });
  ipcMain.handle('engram:get-mcp-write-mode', () => getMcpWriteMode(configDir));
  ipcMain.handle('engram:set-mcp-write-mode', (_e, mode: string) => { setMcpWriteMode(configDir, mode as 'propose' | 'write'); });
  ipcMain.handle('engram:open-path', (_e, which: string) => {
    const dirs: Record<string, string> = {
      data: dataDir,
      logs: path.join(dataDir, 'logs'),
      config: configDir,
    };
    const target = dirs[which] ?? dataDir;
    fs.mkdirSync(target, { recursive: true });
    return shell.openPath(target);
  });
  ipcMain.handle('engram:restart', () => restartChild());
  ipcMain.handle('engram:log-tail', () => {
    try {
      const text = fs.readFileSync(path.join(dataDir, 'logs', 'engram.log'), 'utf8');
      return text.split('\n').slice(-100).join('\n');
    } catch {
      return '(로그 없음)';
    }
  });
  ipcMain.handle('engram:pick-folder', async () => {
    const win = chatWin ?? undefined;
    const r = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });
  ipcMain.handle('engram:setup-code', () => readSetupCode(path.join(dataDir, 'state')));
  ipcMain.handle('engram:add-local-brain', (_e, name: string) => {
    const cfg = loadChatConfig(configDir, childEnv);
    const b = addLocalBrain(configDir, dataDir, name, [cfg.port]);
    startLocalBrain(b);
    return { endpoint: `ws://127.0.0.1:${b.port}`, name: b.name };
  });
  ipcMain.handle('engram:list-mcp-servers', () => listMcpServersFile(configDir));
  ipcMain.handle('engram:add-mcp-server', (_e, name: string, command: string, argsLine: string) =>
    addMcpServer(configDir, name, command, argsLine));
  ipcMain.handle('engram:remove-mcp-server', (_e, name: string) => { removeMcpServer(configDir, name); });
  ipcMain.handle('engram:sync-claude-mcp', () => {
    mirrorClaudeMcp(configDir, readClaudeMcpServers());
    return listMcpServersFile(configDir);
  });
  // 코드 패널 터미널: 스폰·입출력·리사이즈·종료 전부 IPC 경유(렌더러 직접 노드 접근 금지).
  ipcMain.handle('engram:pty-start', (_e, channelId: string, cwd: string) => ptyManager.start(channelId, cwd));
  ipcMain.handle('engram:pty-write', (_e, sid: string, data: string) => { ptyManager.write(sid, data); });
  ipcMain.handle('engram:pty-resize', (_e, sid: string, cols: number, rows: number) => { ptyManager.resize(sid, cols, rows); });
  ipcMain.handle('engram:pty-kill', (_e, sid: string) => { ptyManager.kill(sid); });
  ipcMain.handle('engram:pty-replay', (_e, sid: string) => ptyManager.replay(sid));
  // 코드 패널 diff 뷰: 읽기 전용(git-diff.ts, never-throw 결과형).
  ipcMain.handle('engram:git-diff-status', (_e, repoPath: string) => diffStatus(repoPath));
  ipcMain.handle('engram:git-diff-file', (_e, repoPath: string, file: string) => diffFile(repoPath, file));
}

// ---- 부팅 ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit(); // 중복 실행: 기존 인스턴스에 양보(스펙 §7)
} else {
  // 아이콘 재클릭(중복 실행) = 기존 창 포커스(스펙 §7). 창이 있으면 그걸 복원·포커스,
  // 트레이 상주라 창이 하나도 없을 수도 있으면 채팅창을 새로 열어 트레이 더블클릭과 동일하게 반응한다.
  app.on('second-instance', () => {
    const win = chatWin ?? settingsWin;
    if (win) focusOrRestore(win);
    else openChat();
  });
  app.on('before-quit', () => {
    quitting = true;
    // 윈도우에서 child.kill()(TerminateProcess 1회)은 유틸리티 서브트리를 못 지울 수 있다 —
    // 실사고(2026-07-24): 자동 업데이트 종료 후 NodeService 백엔드가 고아로 살아남아 47800을
    // 계속 점유, 새 버전이 '시작 중'에서 영구 대기. 윈도우는 taskkill /T /F로 트리째 강제 종료.
    if (process.platform === 'win32' && child?.pid) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 이미 죽음 등 — 격리 */ }
    } else {
      child?.kill();
    }
    brainProcs.forEach((p) => p.kill());
    ptyManager.killAll(); // 터미널 세션 고아 방지
  });
  // 창을 다 닫아도 트레이 상주 유지(기본 quit 동작 차단).
  app.on('window-all-closed', () => {});
  void app.whenReady().then(() => {
    // 기본 메뉴바(File/Edit/View…) 제거 — 설정창엔 불필요하고 미완성처럼 보인다. macOS는 앱 메뉴 관례상 유지.
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    // 로그인 자동시작(스펙 §3). Linux는 API 미지원이라 제외, 개발 모드(비패키지)도 제외.
    if (app.isPackaged && process.platform !== 'linux') {
      app.setLoginItemSettings({ openAtLogin: true });
    }
    // 자동 업데이트(NSIS): GitHub Release에서 새 버전 확인→다운로드→종료 시 설치.
    // Windows 한정 — 무서명 mac은 electron-updater가 서명을 요구해 불가. 실패는 조용히 무시(오프라인 등).
    if (app.isPackaged && process.platform === 'win32') {
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    }
    registerIpc();
    createTray();
    // dev 스모크 편의: 트레이 조작 없이 설정창 바로 열기 (ENGRAM_OPEN_SETTINGS=1 electron .)
    if (process.env.ENGRAM_OPEN_SETTINGS === '1') openSettings();
    // dev 스모크 편의(T4 실측 검증): 트레이 더블클릭 없이 채팅창 바로 열기 (ENGRAM_OPEN_CHAT=1 electron .)
    if (process.env.ENGRAM_OPEN_CHAT === '1') openChat();
    startChild();
    for (const b of loadLocalBrains(configDir)) startLocalBrain(b); // + 로컬 두뇌 재기동(재시작 감독 없음 — ponytail)
  });
}
