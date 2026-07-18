import { BrainProvider } from '../brain/brain.port';
import { PinoLogger } from '../pal/logger';

// DI 토큰: 이름→두뇌 해소 함수(agent-layer.module에서 만들어 BrainDelegator·ChannelBrainResolver가
// 공유 — 8d에서 검증된 프로필별 새 인스턴스·세마포어 분리 정책을 유지하며 캐시를 새로 만들지 않는다).
export const BRAIN_NAME_RESOLVE = Symbol('BRAIN_NAME_RESOLVE');
export type BrainNameResolve = (name: string) => BrainProvider;

// 채널별 두뇌 해소(스펙 §3.2). 이름 미지정 → 주입된 기본 두뇌 그대로(회귀 0).
// 이름 지정 → 이름→두뇌 캐시(위임기와 동일 인스턴스 정책)로 resolve.
// 실패(삭제된 프로필·미지원 provider 등) → 기본 두뇌로 폴백 + warn 로그(never-throw —
// 방이 침묵하는 것보다 기본 두뇌로 답하는 게 낫다).
export class ChannelBrainResolver {
  constructor(
    private readonly resolveByName: BrainNameResolve,
    private readonly defaultBrain: BrainProvider,
    private readonly logger: PinoLogger,
  ) {}

  resolve(name: string | undefined): BrainProvider {
    if (!name) return this.defaultBrain;
    try {
      return this.resolveByName(name);
    } catch (err) {
      this.logger.warn(`채널 두뇌 해소 실패(기본으로 폴백) "${name}": ${String(err)}`, 'ChannelBrainResolver');
      return this.defaultBrain;
    }
  }
}
