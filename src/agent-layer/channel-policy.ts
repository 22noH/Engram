import * as fs from 'fs';
import * as path from 'path';

// 채널별 능력 정책(Phase 6c). runtime/config/channels.json — 없음/깨짐이면 전부 기본값(coderepos 패턴).
export type Capability = 'coding' | 'schedule' | 'collaborate' | 'observe' | 'ambient';

export interface ChannelPolicy {
  channels: Record<string, Partial<Record<Capability, boolean>>>;
}

// 기본값: 명령·조용한 ambient는 허용(설정 0=현행 동작), 끼어들기(observe)만 opt-in.
const DEFAULTS: Record<Capability, boolean> = {
  coding: true, schedule: true, collaborate: true, ambient: true, observe: false,
};

export function loadChannelPolicy(configDir: string): ChannelPolicy {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(configDir, 'channels.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const channels: ChannelPolicy['channels'] = {};
      for (const [id, caps] of Object.entries(parsed as Record<string, unknown>)) {
        if (!caps || typeof caps !== 'object' || Array.isArray(caps)) continue;
        const clean: Partial<Record<Capability, boolean>> = {};
        for (const [k, v] of Object.entries(caps as Record<string, unknown>)) {
          if (k in DEFAULTS && typeof v === 'boolean') clean[k as Capability] = v;
        }
        channels[id] = clean;
      }
      return { channels };
    }
  } catch { /* 없음/깨짐 → 기본값 */ }
  return { channels: {} };
}

export function allows(policy: ChannelPolicy, channelId: string, cap: Capability): boolean {
  return policy.channels[channelId]?.[cap] ?? DEFAULTS[cap];
}
