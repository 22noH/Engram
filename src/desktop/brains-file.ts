import * as fs from 'fs';
import * as path from 'path';

// brains.json 병합 쓰기(설정창 공용): 다른 프로필·설정 보존, 깨진 파일은 기본 골격으로 재작성.
export function mergeBrainProfile(configDir: string, name: string, profile: Record<string, unknown>, setDefault = false): void {
  const file = path.join(configDir, 'brains.json');
  let cfg: { default: string; brains: Record<string, unknown> } = { default: 'claude', brains: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') {
      const brains = typeof raw.brains === 'object' && raw.brains !== null && !Array.isArray(raw.brains) ? raw.brains : {};
      const def = typeof raw.default === 'string' ? raw.default : 'claude';
      cfg = { default: def, brains };
    }
  } catch {
    // 없거나 깨짐 → 기본 골격
  }
  // ponytail: defineProperty — '__proto__' 같은 이름도 own property로(브래킷 대입은 프로토타입을 건드려 조용히 유실).
  Object.defineProperty(cfg.brains, name, { value: profile, enumerable: true, writable: true, configurable: true });
  if (setDefault) cfg.default = name;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}

// 두뇌 목록(설정창 드롭다운용). provider·model·기본여부.
export function listBrains(configDir: string): Array<{ key: string; provider: string; model: string; isDefault: boolean }> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'brains.json'), 'utf8'));
    const brains = raw && typeof raw.brains === 'object' && raw.brains ? raw.brains : {};
    const def = typeof raw?.default === 'string' ? raw.default : 'claude';
    return Object.keys(brains).map((key) => ({
      key,
      provider: String(brains[key]?.provider ?? ''),
      model: String(brains[key]?.model ?? ''),
      isDefault: key === def,
    }));
  } catch {
    return [];
  }
}

// 기본 두뇌 전환(default 필드만 갱신, 나머지 보존). 파일 없음/깨짐이면 no-op.
export function setDefaultBrain(configDir: string, key: string): void {
  const file = path.join(configDir, 'brains.json');
  let raw: { default?: string; brains?: Record<string, unknown> };
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  if (!raw || typeof raw !== 'object') return;
  raw.default = key;
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
}

// 모델명 → 두뇌 이름 제안 (qwen3:8b → qwen3-8b). 위임 때 채팅에서 이름으로 부르므로 부르기 쉬운 형태.
export function slugFromModel(model: string): string {
  const s = model.toLowerCase().replace(/[^a-z0-9_]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'ollama';
}

// 프로필 삭제. default면 no-op — 기본 두뇌가 사라지면 서버가 시작을 못 하므로 파일 계층이 최종 안전선.
export function removeBrainProfile(configDir: string, key: string): void {
  const file = path.join(configDir, 'brains.json');
  let raw: { default?: string; brains?: Record<string, unknown> };
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  if (!raw || typeof raw !== 'object' || !raw.brains || typeof raw.brains !== 'object') return;
  if (raw.default === key) return;
  if (!(key in raw.brains)) return;
  delete raw.brains[key];
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
}

export interface BrainDetail {
  key: string; provider: string; model: string; baseUrl: string;
  maxTokens: number | null; inputUsdPerMTok: number | null; outputUsdPerMTok: number | null;
  searchProvider: string; hasApiKey: boolean; hasSearchApiKey: boolean; isDefault: boolean;
}

// 편집 폼용 상세 목록. ★API 키 원문은 렌더러로 안 보낸다 — has* boolean만.
export function listBrainDetails(configDir: string): BrainDetail[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'brains.json'), 'utf8'));
    const brains = raw && typeof raw.brains === 'object' && raw.brains && !Array.isArray(raw.brains) ? raw.brains : {};
    const def = typeof raw?.default === 'string' ? raw.default : 'claude';
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
    return Object.keys(brains).map((key) => {
      const b = brains[key] ?? {};
      return {
        key,
        provider: String(b.provider ?? ''),
        model: String(b.model ?? ''),
        baseUrl: String(b.baseUrl ?? ''),
        maxTokens: num(b.maxTokens),
        inputUsdPerMTok: num(b.inputUsdPerMTok),
        outputUsdPerMTok: num(b.outputUsdPerMTok),
        searchProvider: String(b.searchProvider ?? ''),
        hasApiKey: typeof b.apiKey === 'string' && b.apiKey.length > 0,
        hasSearchApiKey: typeof b.searchApiKey === 'string' && b.searchApiKey.length > 0,
        isDefault: key === def,
      };
    });
  } catch {
    return [];
  }
}

export interface BrainPatch {
  model?: string; baseUrl?: string; searchProvider?: string;
  apiKey?: string; searchApiKey?: string;
  maxTokens?: number | null; inputUsdPerMTok?: number | null; outputUsdPerMTok?: number | null;
}

// 프로필 부분 갱신(+선택 이름변경). 규칙: 문자열 ''=필드 제거(키 계열은 예외=보존),
// 숫자 null=필드 제거·유한 양수만 채택. 이름변경은 default 포인터까지 원자 이동,
// newKey 충돌·없는 key·깨진 파일은 false(무변경).
export function updateBrainProfile(configDir: string, key: string, patch: BrainPatch, newKey?: string): boolean {
  const file = path.join(configDir, 'brains.json');
  let raw: { default?: string; brains?: Record<string, Record<string, unknown>> };
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  if (!raw || typeof raw !== 'object' || !raw.brains || typeof raw.brains !== 'object') return false;
  const profile = raw.brains[key];
  if (!profile || typeof profile !== 'object') return false;

  const setStr = (field: 'model' | 'baseUrl' | 'searchProvider'): void => {
    const v = patch[field];
    if (v === undefined) return;
    if (v === '') delete profile[field];
    else profile[field] = v;
  };
  const setSecret = (field: 'apiKey' | 'searchApiKey'): void => {
    const v = patch[field];
    if (v === undefined || v === '') return; // 빈 입력 = 기존 보존
    profile[field] = v;
  };
  const setNum = (field: 'maxTokens' | 'inputUsdPerMTok' | 'outputUsdPerMTok'): void => {
    const v = patch[field];
    if (v === undefined) return;
    if (v === null) { delete profile[field]; return; }
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) profile[field] = v;
  };
  setStr('model'); setStr('baseUrl'); setStr('searchProvider');
  setSecret('apiKey'); setSecret('searchApiKey');
  setNum('maxTokens'); setNum('inputUsdPerMTok'); setNum('outputUsdPerMTok');

  if (newKey !== undefined && newKey !== key) {
    if (!newKey.trim() || newKey in raw.brains) return false;
    Object.defineProperty(raw.brains, newKey, { value: profile, enumerable: true, writable: true, configurable: true });
    delete raw.brains[key];
    if (raw.default === key) raw.default = newKey;
  }
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  return true;
}
