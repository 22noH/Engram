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
  timeoutMs: 120000,
  extraArgs: [],
};

const DEFAULT_FILE: BrainsFile = { default: 'claude', brains: { claude: { ...DEFAULTS } } };

// env 값이 유한한 양수일 때만 채택, 아니면 폴백 유지(NaN/음수/0 방어).
function posIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// runtime/config/brains.json에서 활성(default) 두뇌 프로필을 해소한다.
// 파일이 없으면 기본 파일을 1회 생성(사용자가 편집 가능). env는 활성 프로필 덮어쓰기.
export function loadActiveBrain(configDir: string, env: NodeJS.ProcessEnv = process.env): BrainProfile {
  const file = path.join(configDir, 'brains.json');
  let cfg: BrainsFile;
  if (fs.existsSync(file)) {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as BrainsFile;
  } else {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(DEFAULT_FILE, null, 2));
    cfg = DEFAULT_FILE;
  }

  const raw = cfg.brains?.[cfg.default];
  if (!raw) throw new Error(`brains.json: default '${cfg.default}' 프로필이 없습니다`);
  const profile: BrainProfile = { ...DEFAULTS, ...raw };

  if (env.ENGRAM_BRAIN_CLI) profile.cli = env.ENGRAM_BRAIN_CLI;
  if (env.ENGRAM_BRAIN_MODEL) profile.model = env.ENGRAM_BRAIN_MODEL;
  // 비숫자·음수·0 env는 무시(NaN이면 Semaphore 상한·타임아웃이 무력화되므로). 유효할 때만 덮어쓴다.
  profile.concurrency = posIntEnv(env.ENGRAM_BRAIN_CONCURRENCY, profile.concurrency);
  profile.timeoutMs = posIntEnv(env.ENGRAM_BRAIN_TIMEOUT_MS, profile.timeoutMs);

  if (profile.provider !== 'claude-cli') {
    throw new Error(`지원하지 않는 provider: ${profile.provider} (Phase 1은 claude-cli만)`);
  }
  return profile;
}
