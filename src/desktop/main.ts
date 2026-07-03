// Electron 껍데기(스펙 §3): 트레이 상주 + 설정창 + 자식(상주 main.js) 감독. 로직은 테스트된 모듈에 위임.
import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray, utilityProcess } from 'electron';
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
  child = utilityProcess.fork(entry, [], { env: childEnv, stdio: 'ignore', serviceName: 'engram-core' });
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
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  void settingsWin.loadFile(path.join(app.getAppPath(), 'src', 'desktop', 'settings.html'));
  settingsWin.on('closed', () => (settingsWin = null));
}

// ---- 채팅 창(Phase 9): 자식(상주)이 서빙하는 페이지를 그대로 로드 — 폰 브라우저와 단일 코드 경로 ----
function openChat(): void {
  if (chatWin) {
    chatWin.focus();
    return;
  }
  const cfg = loadChatConfig(configDir, childEnv);
  chatWin = new BrowserWindow({ width: 980, height: 720, title: 'Engram' });
  const load = (): void => {
    void chatWin?.loadURL(`http://127.0.0.1:${cfg.port}/`);
  };
  // 자식이 아직 리슨 전이면 로드 실패 → 2초 후 재시도(자식 감독 백오프와 별개, 창 닫히면 중단).
  chatWin.webContents.on('did-fail-load', () => {
    setTimeout(() => { if (chatWin) load(); }, 2000);
  });
  chatWin.on('closed', () => (chatWin = null));
  load();
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
