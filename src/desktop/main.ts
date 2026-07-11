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
import { saveDiscordToken } from './messenger-writer';
import { loadChatConfig } from '../edge/messenger/chat.config';
import { resolveLanguage } from '../agent-layer/language';
import * as nodeHttp from 'http';

const dataDir = app.getPath('userData'); // 예: %APPDATA%/Engram
const configDir = path.join(dataDir, 'config');
const childEnv = {
  ...process.env,
  ENGRAM_DATA_DIR: dataDir,
  ENGRAM_MODEL_CACHE_DIR: path.join(dataDir, 'models'),
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
    height: 680,
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
  const probe = (): void => {
    if (!chatWin) return; // 창 닫힘 = 폴링 중단
    nodeHttp.get(healthUrl, (res) => {
      res.resume();
      const lang = resolveLanguage(cfg.language, app.getLocale());
      if (chatWin) void chatWin.loadFile(rendererIndex, { search: `port=${cfg.port}&lang=${lang}` }); // 헬스 200 → 클라 로드(포트·언어 주입)
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
  ipcMain.handle('engram:add-ollama', (_e, model: string, setDefault: boolean) => {
    addOllamaProfile(configDir, model, setDefault);
  });
  ipcMain.handle('engram:save-token', (_e, token: string) => {
    saveDiscordToken(configDir, token);
  });
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
    startChild();
  });
}
