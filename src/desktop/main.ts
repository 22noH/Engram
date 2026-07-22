// Electron 껍데기(스펙 §3): 트레이 상주 + 설정창 + 자식(상주 main.js) 감독. 로직은 테스트된 모듈에 위임.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray, utilityProcess } from 'electron';
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
import * as nodeHttp from 'http';

const dataDir = app.getPath('userData'); // 예: %APPDATA%/Engram
const configDir = path.join(dataDir, 'config');
const childEnv = {
  ...process.env,
  ENGRAM_DATA_DIR: dataDir,
  ENGRAM_MODEL_CACHE_DIR: path.join(dataDir, 'models'),
  // 리뷰 지적: 데스크톱 백엔드는 /admin(서버 콘솔)을 절대 서빙하지 않는다 — 콘솔은 서버 에디션
  // 전용 물건. startChild(상주 main.js)·startLocalBrain(로컬 두뇌) 둘 다 이 childEnv를 물려받는다
  // — 로컬 두뇌엔 무해(brain 모드는 애초에 adminDeps 미배선). main.ts가 isServer && 이 값 !== '1'
  // 일 때만 adminDeps를 배선(src/main.ts), self.adapter.ts가 라우팅에서도 한 번 더 확인(방어 이중화).
  ENGRAM_DESKTOP: '1',
};

let tray: Tray | null = null;
let settingsWin: BrowserWindow | null = null;
let chatWin: BrowserWindow | null = null;
let child: UtilityProcess | null = null;
let quitting = false;
let childStartedAt = 0;
const backoff = new Backoff();

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
  const overlay = (): Electron.TitleBarOverlay =>
    nativeTheme.shouldUseDarkColors
      ? { color: '#12161d', symbolColor: '#e6edf3', height: 36 }
      : { color: '#ffffff', symbolColor: '#1c2733', height: 36 };
  chatWin = new BrowserWindow({
    width: 980, height: 720, title: 'Engram',
    icon: trayIcon(), // dev 모드 작업표시줄에 Electron 기본 로고 대신 뇌 아이콘
    titleBarStyle: 'hidden', titleBarOverlay: overlay(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0e13' : '#f2f7fb',
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
    '<style>body{background:#f2f7fb;color:#5c6b7a;font-family:system-ui;display:flex;' +
    'align-items:center;justify-content:center;height:100vh;margin:0}' +
    '@media(prefers-color-scheme:dark){body{background:#0b0e13;color:#8b95a3}}</style>' +
    `<div>${ko() ? 'Engram 시작 중…' : 'Starting Engram…'}</div>`,
  );
  // 배포 프리셋(configDir/preset.json — `{name,endpoint}`): 있으면 렌더러 URL에 주입해
  // connections.ts seed()가 그 서버를 기본 연결로 시드하게 한다. 없으면 기존 local-only 그대로.
  // 읽기+기본이름 채움 로직은 preset-file.ts로 추출됨(서버 콘솔 S3 Task 2 — admin-http의
  // 프리셋 생성(buildPreset)과 셰이프를 공유, 동작 자체는 무변경).
  let preset = '';
  const p = readPresetFile(configDir);
  if (p) preset = `&presetName=${encodeURIComponent(p.name)}&presetEndpoint=${encodeURIComponent(p.endpoint)}`;
  const probe = (): void => {
    if (!chatWin) return; // 창 닫힘 = 폴링 중단
    nodeHttp.get(healthUrl, (res) => {
      res.resume();
      const lang = resolveLanguage(cfg.language, app.getLocale());
      if (chatWin) void chatWin.loadFile(rendererIndex, { search: `port=${cfg.port}&lang=${lang}${preset}` }); // 헬스 200 → 클라 로드(포트·언어·프리셋 주입)
    }).on('error', () => { setTimeout(probe, 2000); });
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
}

// ---- 부팅 ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit(); // 중복 실행: 기존 인스턴스에 양보(스펙 §7)
} else {
  app.on('second-instance', () => openSettings());
  app.on('before-quit', () => {
    quitting = true;
    child?.kill();
    brainProcs.forEach((p) => p.kill());
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
    startChild();
    for (const b of loadLocalBrains(configDir)) startLocalBrain(b); // + 로컬 두뇌 재기동(재시작 감독 없음 — ponytail)
  });
}
