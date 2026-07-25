import * as fs from 'fs';
import * as path from 'path';

// 폴더 자동 변환 설정(config/folder-import.json). 설정창(Electron 메인)과 상주 백엔드가
// 같은 파일을 읽는다 — 저장하면 백엔드의 워처가 파일 변경을 보고 즉시 반영한다(재시작 불필요).
// 관례는 wiki-remote.config.ts와 동일(없거나 깨지면 안전한 기본값, 자격증명은 담지 않음).

export interface FolderImportConfig {
  /** 감시 켜기. 꺼져 있으면 워처는 폴더를 열지 않는다. */
  enabled: boolean;
  /** 감시할 폴더(절대경로). 비면 감시 안 함. */
  folder: string;
  /** 'ai'=두뇌가 제목·요약·분류를 만들어 정리 · 'raw'=원문 그대로 한 페이지. */
  mode: 'ai' | 'raw';
  /** 'propose'=승인함으로(기본) · 'direct'=바로 게시. */
  publish: 'propose' | 'direct';
  /** 한 번 스캔에서 처리할 최대 파일 수(초과분은 대기). */
  maxFilesPerRun: number;
  /** 이 크기를 넘는 파일은 읽지 않는다(바이트). */
  maxFileBytes: number;
  /** 두뇌에 넘길 본문 문자 상한(초과분은 잘라내고 표시). */
  maxTextChars: number;
}

export const IMPORT_CONFIG_FILE = 'folder-import.json';

export const DEFAULT_IMPORT_CONFIG: FolderImportConfig = {
  enabled: false,
  folder: '',
  mode: 'ai',
  publish: 'propose',
  // 비용 상한 기본값 — 처음 폴더를 켰을 때 수백 개가 한꺼번에 두뇌로 가지 않게.
  maxFilesPerRun: 5,
  maxFileBytes: 25 * 1024 * 1024,
  maxTextChars: 60_000,
};

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** raw JSON → 검증된 설정(순수 함수 — 파일 접근 없음, 테스트 대상). */
export function normalizeImportConfig(raw: unknown): FolderImportConfig {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Partial<FolderImportConfig>;
  return {
    enabled: o.enabled === true,
    folder: typeof o.folder === 'string' ? o.folder.trim() : '',
    mode: o.mode === 'raw' ? 'raw' : 'ai',
    publish: o.publish === 'direct' ? 'direct' : 'propose',
    maxFilesPerRun: clampInt(o.maxFilesPerRun, 1, 200, DEFAULT_IMPORT_CONFIG.maxFilesPerRun),
    maxFileBytes: clampInt(o.maxFileBytes, 1024, 500 * 1024 * 1024, DEFAULT_IMPORT_CONFIG.maxFileBytes),
    maxTextChars: clampInt(o.maxTextChars, 1000, 500_000, DEFAULT_IMPORT_CONFIG.maxTextChars),
  };
}

export function loadImportConfig(configDir: string): FolderImportConfig {
  try {
    return normalizeImportConfig(JSON.parse(fs.readFileSync(path.join(configDir, IMPORT_CONFIG_FILE), 'utf8')));
  } catch {
    return { ...DEFAULT_IMPORT_CONFIG };
  }
}

export function saveImportConfig(configDir: string, cfg: Partial<FolderImportConfig>): FolderImportConfig {
  const out = normalizeImportConfig({ ...loadImportConfig(configDir), ...cfg });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, IMPORT_CONFIG_FILE), JSON.stringify(out, null, 2));
  return out;
}

/** 상태 파일 경로(처리 이력). state/ 아래 — 설정창도 같은 파일을 읽어 "최근 처리"를 그린다. */
export function importLedgerPath(stateDir: string): string {
  return path.join(stateDir, 'folder-import.json');
}

/**
 * "지금 검사" 트리거 파일. 설정창(Electron 메인)이 이 파일의 mtime을 건드리면 상주 백엔드의
 * 워처가 즉시 스캔한다 — 자식 프로세스 IPC 프로토콜을 새로 만들지 않고 폴더 감시라는
 * 이 기능의 성격을 그대로 재사용하는 방식(다른 에이전트가 작업 중인 MCP 경로도 안 건드린다).
 */
export function importTriggerPath(stateDir: string): string {
  return path.join(stateDir, 'folder-import.trigger');
}

export function touchImportTrigger(stateDir: string): void {
  const p = importTriggerPath(stateDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, new Date().toISOString());
}
