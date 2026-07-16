import * as fs from 'fs';
import * as path from 'path';

// 두뇌 프로필 — brains.json의 한 항목(설계 §4.3).
export interface BrainProfile {
  provider: string;
  cli: string;
  model: string;
  concurrency: number;
  timeoutMs: number;
  extraArgs: string[];
  env?: Record<string, string>;
  // Phase 8a — engram 자체 하네스(API 직접 호출) 프로필 필드
  apiKey?: string;             // anthropic-api 필수, openai-api 옵셔널(Ollama 불필요)
  baseUrl?: string;            // openai-api 필수, anthropic-api는 기본 https://api.anthropic.com
  maxTokens?: number;          // 기본 16000
  inputUsdPerMTok?: number;    // costUsd 계산용(기본 0 — 가격표 하드코딩 안 함)
  outputUsdPerMTok?: number;
  searchProvider?: 'duckduckgo' | 'brave' | 'tavily'; // web_search 소스(기본 duckduckgo)
  searchApiKey?: string;       // brave/tavily용
}

interface BrainsFile {
  default: string;
  brains: Record<string, Partial<BrainProfile>>;
}

const DEFAULTS: BrainProfile = {
  provider: 'claude-cli',
  cli: 'claude',
  model: '',
  concurrency: 2,
  // 웹검색·다단 분석은 2분을 넘긴다(전문가 협업이 120s에 잘려 전멸하던 실사용 발견). 5분으로 넉넉히.
  timeoutMs: 300000,
  extraArgs: [], // 웹검색 기본허용은 ClaudeCliBrain이 --allowedTools 미지정 시 자동 주입(프로필 무관 단일화)
  env: {},
};

const DEFAULT_FILE: BrainsFile = {
  default: 'claude',
  brains: { claude: { ...DEFAULTS }, judge: { ...DEFAULTS } }, // judge 분리는 사용자가 모델만 바꾸면 됨
};

// env 값이 유한한 양수일 때만 채택, 아니면 폴백 유지(NaN/음수/0 방어).
function posIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// 파일 로드(+없으면 기본 파일 1회 생성).
function readBrainsFile(configDir: string): BrainsFile {
  const file = path.join(configDir, 'brains.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as BrainsFile;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(DEFAULT_FILE, null, 2));
  return DEFAULT_FILE;
}

// 한 프로필을 DEFAULTS 위에 병합 + env 덮어쓰기 + provider 검증.
function resolve(cfg: BrainsFile, name: string, env: NodeJS.ProcessEnv): BrainProfile {
  const raw = cfg.brains?.[name];
  if (!raw) throw new Error(`brains.json: '${name}' 프로필이 없습니다`);
  const profile: BrainProfile = { ...DEFAULTS, ...raw };
  if (env.ENGRAM_BRAIN_CLI) profile.cli = env.ENGRAM_BRAIN_CLI;
  if (env.ENGRAM_BRAIN_MODEL) profile.model = env.ENGRAM_BRAIN_MODEL;
  // 비숫자·음수·0 env는 무시(NaN이면 Semaphore 상한·타임아웃이 무력화되므로). 유효할 때만 덮어쓴다.
  profile.concurrency = posIntEnv(env.ENGRAM_BRAIN_CONCURRENCY, profile.concurrency);
  profile.timeoutMs = posIntEnv(env.ENGRAM_BRAIN_TIMEOUT_MS, profile.timeoutMs);
  if (env.ENGRAM_BRAIN_API_KEY) profile.apiKey = env.ENGRAM_BRAIN_API_KEY;
  if (env.ENGRAM_BRAIN_BASE_URL) profile.baseUrl = env.ENGRAM_BRAIN_BASE_URL;
  const ALLOWED = ['claude-cli', 'gemini-cli', 'codex-cli', 'anthropic-api', 'openai-api'];
  if (!ALLOWED.includes(profile.provider)) {
    throw new Error(`지원하지 않는 provider: ${profile.provider}`);
  }
  return profile;
}

// runtime/config/brains.json에서 활성(default) 두뇌 프로필을 해소한다.
// 파일이 없으면 기본 파일을 1회 생성(사용자가 편집 가능). env는 활성 프로필 덮어쓰기.
export function loadActiveBrain(configDir: string, env: NodeJS.ProcessEnv = process.env): BrainProfile {
  const cfg = readBrainsFile(configDir);
  if (!cfg.brains?.[cfg.default]) throw new Error(`brains.json: default '${cfg.default}' 프로필이 없습니다`);
  return resolve(cfg, cfg.default, env);
}

// name 프로필이 없으면 default로 폴백(별도 judge는 opt-in).
export function loadBrainProfile(configDir: string, name: string, env: NodeJS.ProcessEnv = process.env): BrainProfile {
  const cfg = readBrainsFile(configDir);
  const target = cfg.brains?.[name] ? name : cfg.default;
  return resolve(cfg, target, env);
}
