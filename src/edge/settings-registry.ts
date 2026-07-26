import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isFilesystemRoot, isWithin, systemDirs } from '../pal/path-safety';
import { findRepoRoot } from '../pal/repo-root';
import { loadImportConfig, saveImportConfig } from '../knowledge-core/import/import.config';
import { readWikiRemoteForm, saveWikiRemote } from '../knowledge-core/wiki/wiki-remote.config';
import { loadWikiSaveMode, saveWikiSaveMode, type WikiSaveMode } from '../knowledge-core/wiki/wiki-save.config';
import { defaultBrainName, listBrainNames } from '../brain/brain.config';

// ─────────────────────────────────────────────────────────────────────────────
// 설정 레지스트리 — 앱 설정창 밖에서도 설정을 바꿀 수 있게 하는 **단일 출처**(2026-07-25).
//
// 왜: MCP만 쓰는 사용자(클로드·코덱스)는 설정 화면이 없어 JSON 파일을 손으로 고칠 수밖에 없었다.
// 이제 세 경로가 생긴다 — ①AI에게 말로(MCP 도구 engram_config_get/set) ②슬래시 명령
// (plugin/commands/config*.md → 결국 같은 MCP 도구) ③터미널(engram config get/set).
//
// ★설계 원칙 1: 세 경로 전부 **이 파일**의 planSettingChange/applySettingChange만 호출한다.
//   실제 저장은 기존 로더(import.config.ts / wiki-remote.config.ts)에 위임 — 앱 설정창이 쓰는
//   바로 그 함수, 그 파일이다. 판정·검증 로직은 여기 한 곳에만 있다(복사 금지).
// ★설계 원칙 2: 위험한 설정은 값 단위로 분류한다(riskOf). 위험이면 호출자가 사람 승인을
//   받아야 한다 — MCP는 elicitation 대화상자, 터미널은 사람이 직접 친 명령 자체가 승인이다.
// ★설계 원칙 3: 감시 폴더 경로는 승인으로도 못 뚫는 하드 거부가 있다(시스템 폴더·엔그램 자기
//   저장소·엔그램 데이터 폴더). PermissionFence의 백스톱 관례와 같은 결.
// ─────────────────────────────────────────────────────────────────────────────

export type SettingRisk = 'safe' | 'danger';

export interface SettingView {
  key: string;
  /** 현재 값(빈 문자열 = 미설정). */
  value: string;
  description: string;
  /** 허용 값 안내(도움말·도구 설명 공용). */
  valueHint: string;
  /** true면 이번 범위에서 읽기 전용(앱/설정 파일에서만 변경). */
  readOnly: boolean;
}

export interface SettingPlanOk {
  ok: true;
  key: string;
  from: string;
  to: string;
  risk: SettingRisk;
  /** 위험 사유(사람에게 보여줄 한 문장). risk==='safe'면 빈 문자열. */
  reason: string;
  /** 이미 같은 값이면 true — 호출자는 승인 대화상자 없이 "변경 없음"으로 끝내면 된다. */
  unchanged: boolean;
}
export interface SettingPlanError { ok: false; error: string }
export type SettingPlan = SettingPlanOk | SettingPlanError;

export interface PlanContext {
  configDir: string;
  /** 엔그램 데이터 루트(<data>/config의 부모). 감시 폴더로 지정 금지 — 자기 위키를 다시 먹는 순환. */
  dataDir: string;
  /** 엔그램 소스 저장소 루트(있으면). 감시 폴더 금지 — 자기수정 백스톱과 같은 결. */
  repoRoot: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
}

type ParseResult = { error: string } | { value: string; risk?: SettingRisk; reason?: string };

interface SettingDef {
  key: string;
  description: string;
  valueHint: string;
  read(configDir: string): string;
  /** 없으면 읽기 전용. */
  write?(configDir: string, value: string): void;
  /** 검증·정규화·위험도. 없으면 값 그대로 안전 취급. */
  parse?(raw: string, ctx: PlanContext): ParseResult;
}

// ── 값 파서 조각 ─────────────────────────────────────────────────────────────
function parseEnum(raw: string, allowed: string[]): ParseResult {
  const v = raw.trim().toLowerCase();
  if (!allowed.includes(v)) return { error: `invalid value "${raw}" — allowed: ${allowed.join(' | ')}` };
  return { value: v };
}

function parseBool(raw: string): ParseResult {
  const v = raw.trim().toLowerCase();
  if (['true', 'on', 'yes', '1'].includes(v)) return { value: 'true' };
  if (['false', 'off', 'no', '0'].includes(v)) return { value: 'false' };
  return { error: `invalid value "${raw}" — allowed: true | false` };
}

function parseInt_(raw: string, min: number, max: number): ParseResult {
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { error: `invalid value "${raw}" — expected a whole number` };
  if (n < min || n > max) return { error: `out of range: ${n} — allowed ${min}..${max}` };
  return { value: String(n) };
}

// git 원격 주소. 자격증명은 담지 않는다(git 표준 인증 위임) — 형식만 최소 검증한다.
function parseGitRemote(raw: string): ParseResult {
  const v = raw.trim();
  if (v === '' || v.toLowerCase() === 'none') return { value: '' }; // 비우기 = 동기화 끔
  if (/\s/.test(v)) return { error: 'invalid git remote — must not contain whitespace' };
  const looksGit = /^(https?:\/\/|ssh:\/\/|git:\/\/|git@|file:\/\/)/i.test(v) || path.isAbsolute(v);
  if (!looksGit) {
    return { error: `invalid git remote "${v}" — expected https://…, git@host:owner/repo.git, ssh://…, or an absolute path` };
  }
  return { value: v };
}

// 감시 폴더 — 하드 거부(승인으로도 못 뚫음) + 너무 넓은 경로는 위험(승인 필요).
export function parseWatchFolder(raw: string, ctx: PlanContext): ParseResult {
  const v = raw.trim().replace(/^["']|["']$/g, '');
  if (v === '' || v.toLowerCase() === 'none') return { value: '' }; // 비우기 = 감시 안 함
  if (!path.isAbsolute(v)) return { error: `folder must be an absolute path: ${v}` };
  const abs = path.resolve(v);

  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { error: `folder does not exist: ${abs}` };
  }
  if (!stat.isDirectory()) return { error: `not a folder: ${abs}` };

  if (systemDirs(ctx.env).some((d) => isWithin(abs, d))) {
    return { error: `refused: ${abs} is inside a system directory — Engram never watches system folders` };
  }
  if (isWithin(abs, ctx.dataDir) || isWithin(ctx.dataDir, abs)) {
    return { error: `refused: ${abs} overlaps Engram's own data folder (${ctx.dataDir}) — it would re-import its own wiki` };
  }
  if (ctx.repoRoot && (isWithin(abs, ctx.repoRoot) || isWithin(ctx.repoRoot, abs))) {
    return { error: `refused: ${abs} overlaps the Engram installation folder (${ctx.repoRoot})` };
  }

  if (isFilesystemRoot(abs)) {
    return { value: abs, risk: 'danger', reason: `${abs} is a whole drive — Engram would read every file under it` };
  }
  if (isWithin(ctx.homeDir, abs)) {
    return { value: abs, risk: 'danger', reason: `${abs} contains your entire home folder — Engram would read every file under it` };
  }
  return { value: abs };
}

// ── 키 정의(단일 출처) ───────────────────────────────────────────────────────
const DEFS: SettingDef[] = [
  {
    key: 'wiki.remote',
    description: 'Git remote the wiki is synced with (empty = local only).',
    valueHint: 'https://… | git@host:owner/repo.git | none',
    read: (c) => readWikiRemoteForm(c).remote,
    write: (c, v) => saveWikiRemote(c, { ...readWikiRemoteForm(c), remote: v }),
    parse: (raw) => {
      const r = parseGitRemote(raw);
      if ('error' in r) return r;
      return {
        value: r.value,
        risk: 'danger',
        reason: r.value
          ? `the entire wiki will be pushed to ${r.value} — pointing it at the wrong repository leaks all of it`
          : 'wiki git sync will be turned off',
      };
    },
  },
  {
    key: 'wiki.autosave',
    description: 'What wiki_propose does: ask = show a Save dialog first (default), direct = save without asking.',
    valueHint: 'ask | direct',
    read: (c) => loadWikiSaveMode(c),
    write: (c, v) => { saveWikiSaveMode(c, v as WikiSaveMode); },
    parse: (raw) => {
      const r = parseEnum(raw, ['ask', 'direct']);
      if ('error' in r) return r;
      // 켜는 순간부터 사람 확인 없이 위키가 바뀐다 — import.publish=direct와 같은 등급.
      return r.value === 'direct'
        ? { value: r.value, risk: 'danger', reason: 'the AI would save to your wiki without asking you first' }
        : r;
    },
  },
  {
    key: 'wiki.branch',
    description: 'Branch used for wiki git sync.',
    valueHint: 'branch name (default: main)',
    read: (c) => readWikiRemoteForm(c).branch,
    write: (c, v) => saveWikiRemote(c, { ...readWikiRemoteForm(c), branch: v }),
    parse: (raw) => {
      const v = raw.trim();
      if (!v || /\s/.test(v)) return { error: `invalid branch name "${raw}"` };
      return { value: v };
    },
  },
  {
    key: 'wiki.syncIntervalSec',
    description: 'How often the wiki is pulled/pushed, in seconds.',
    valueHint: '5..86400',
    read: (c) => String(readWikiRemoteForm(c).syncIntervalSec),
    write: (c, v) => saveWikiRemote(c, { ...readWikiRemoteForm(c), syncIntervalSec: Number(v) }),
    parse: (raw) => parseInt_(raw, 5, 86_400),
  },
  {
    key: 'import.enabled',
    description: 'Watch a folder and turn dropped files into wiki pages.',
    valueHint: 'true | false',
    read: (c) => String(loadImportConfig(c).enabled),
    write: (c, v) => { saveImportConfig(c, { enabled: v === 'true' }); },
    parse: (raw) => parseBool(raw),
  },
  {
    key: 'import.folder',
    description: 'Folder that is watched for new files (empty = none).',
    valueHint: 'absolute folder path | none',
    read: (c) => loadImportConfig(c).folder,
    write: (c, v) => { saveImportConfig(c, { folder: v }); },
    parse: parseWatchFolder,
  },
  {
    key: 'import.mode',
    description: 'How imported files are turned into pages: ai = the brain writes a title/summary, raw = keep the text as-is.',
    valueHint: 'ai | raw',
    read: (c) => loadImportConfig(c).mode,
    write: (c, v) => { saveImportConfig(c, { mode: v as 'ai' | 'raw' }); },
    parse: (raw) => parseEnum(raw, ['ai', 'raw']),
  },
  {
    key: 'import.publish',
    description: 'What happens when a file is converted: propose = queued for human approval, direct = published to the wiki immediately.',
    valueHint: 'propose | direct',
    read: (c) => loadImportConfig(c).publish,
    write: (c, v) => { saveImportConfig(c, { publish: v as 'propose' | 'direct' }); },
    parse: (raw) => {
      const r = parseEnum(raw, ['propose', 'direct']);
      if ('error' in r) return r;
      return r.value === 'direct'
        ? { value: r.value, risk: 'danger', reason: 'imported files would be published to the wiki with no human approval step' }
        : r;
    },
  },
  {
    key: 'import.maxFilesPerRun',
    description: 'Maximum files converted per scan (cost guard).',
    valueHint: '1..200',
    read: (c) => String(loadImportConfig(c).maxFilesPerRun),
    write: (c, v) => { saveImportConfig(c, { maxFilesPerRun: Number(v) }); },
    parse: (raw) => parseInt_(raw, 1, 200),
  },
  // ── 읽기 전용(이번 범위: 조회만) ──────────────────────────────────────────
  {
    key: 'brain.default',
    description: 'Default brain (read-only here — change it in the Engram app).',
    valueHint: 'read-only',
    read: (c) => defaultBrainName(c),
  },
  {
    key: 'brain.list',
    description: 'Registered brains (read-only here — change them in the Engram app).',
    valueHint: 'read-only',
    read: (c) => listBrainNames(c).join(', '),
  },
];

export const SETTING_KEYS: string[] = DEFS.map((d) => d.key);
export const WRITABLE_SETTING_KEYS: string[] = DEFS.filter((d) => d.write).map((d) => d.key);

function findDef(key: string): SettingDef | undefined {
  const k = key.trim().toLowerCase();
  return DEFS.find((d) => d.key.toLowerCase() === k);
}

export function defaultPlanContext(configDir: string, env: NodeJS.ProcessEnv = process.env): PlanContext {
  return {
    configDir,
    dataDir: path.dirname(configDir), // <data>/config → <data>
    repoRoot: findRepoRoot(__dirname),
    homeDir: os.homedir(),
    env,
  };
}

// 값 읽기(전부 자유 — 위험도 개념 없음).
export function listSettings(configDir: string): SettingView[] {
  return DEFS.map((d) => ({
    key: d.key,
    value: safeRead(d, configDir),
    description: d.description,
    valueHint: d.valueHint,
    readOnly: !d.write,
  }));
}

export function readSetting(configDir: string, key: string): SettingView | null {
  const d = findDef(key);
  if (!d) return null;
  return { key: d.key, value: safeRead(d, configDir), description: d.description, valueHint: d.valueHint, readOnly: !d.write };
}

function safeRead(d: SettingDef, configDir: string): string {
  try {
    return d.read(configDir);
  } catch {
    return ''; // 로더는 전부 never-throw지만 방어(설정 조회가 절대 실패하지 않게)
  }
}

export function unknownKeyError(key: string): string {
  return `unknown setting "${key}" — known settings: ${SETTING_KEYS.join(', ')}`;
}

/**
 * 검증·분류만 한다(파일은 건드리지 않는다). 호출자는 risk==='danger'면 사람 승인을 받은 뒤
 * applySettingChange를 부른다 — MCP는 elicitation 대화상자, 터미널은 사람이 친 명령 자체가 승인.
 */
export function planSettingChange(
  configDir: string,
  key: string,
  rawValue: string,
  ctx: PlanContext = defaultPlanContext(configDir),
): SettingPlan {
  const d = findDef(key);
  if (!d) return { ok: false, error: unknownKeyError(key) };
  if (!d.write) {
    return { ok: false, error: `"${d.key}" is read-only here — change it in the Engram app's settings screen` };
  }
  const parsed = d.parse ? d.parse(rawValue, ctx) : { value: rawValue.trim() };
  if ('error' in parsed) return { ok: false, error: parsed.error };
  const from = safeRead(d, configDir);
  return {
    ok: true,
    key: d.key,
    from,
    to: parsed.value,
    risk: parsed.risk ?? 'safe',
    reason: parsed.risk === 'danger' ? (parsed.reason ?? '') : '',
    unchanged: from === parsed.value,
  };
}

/** 실제 저장(앱 설정창과 같은 파일·같은 로더). 승인 판정은 호출자 책임 — 여기선 쓰기만 한다. */
export function applySettingChange(configDir: string, plan: SettingPlanOk): string {
  const d = findDef(plan.key);
  if (!d?.write) throw new Error(unknownKeyError(plan.key)); // planSettingChange를 건너뛴 호출(방어)
  d.write(configDir, plan.to);
  return `${plan.key}: ${display(plan.from)} -> ${display(plan.to)}`;
}

export function display(value: string): string {
  return value === '' ? '(not set)' : value;
}

/** 사람이 읽는 목록(터미널·MCP 공용 — 표현도 한 곳에서). */
export function formatSettings(views: SettingView[]): string {
  const width = Math.max(...views.map((v) => v.key.length));
  return views
    .map((v) => `${v.key.padEnd(width)}  ${display(v.value)}${v.readOnly ? '   (read-only)' : ''}`)
    .join('\n');
}

/** 한 항목 상세(값 + 설명 + 허용 값). */
export function formatSetting(v: SettingView): string {
  return [
    `${v.key} = ${display(v.value)}${v.readOnly ? '   (read-only)' : ''}`,
    v.description,
    `allowed: ${v.valueHint}`,
  ].join('\n');
}
