import { BrainProvider } from '../brain/brain.port';
import { PinoLogger } from '../pal/logger';

// DI 토큰: 이름→두뇌 해소 함수(agent-layer.module에서 만들어 BrainDelegator·ChannelBrainResolver가
// 공유 — 8d에서 검증된 프로필별 새 인스턴스·세마포어 분리 정책을 유지하며 캐시를 새로 만들지 않는다).
export const BRAIN_NAME_RESOLVE = Symbol('BRAIN_NAME_RESOLVE');
export type BrainNameResolve = (name: string) => BrainProvider;

// 채널별 두뇌 해소(스펙 §3.2). 이름 미지정 → 주입된 기본 두뇌 그대로(회귀 0).
// 이름 지정 → 이름→두뇌 캐시(위임기와 동일 인스턴스 정책)로 resolve.
// 실패(미지원 provider 등) → 기본 두뇌로 폴백 + warn 로그(never-throw —
// 방이 침묵하는 것보다 기본 두뇌로 답하는 게 낫다).
// listNames(옵션, BrainDelegator와 동일 주입 패턴): 삭제된 프로필 감지용(스펙 §3.5). loadBrainProfile은
// 미등록 이름을 default로 "조용히" 대체해 절대 throw하지 않으므로(다른 호출부가 그 폴백에 의존 — 바꾸지 않음),
// resolveByName만으로는 삭제된 프로필을 절대 감지할 수 없다. 그래서 resolve 전에 등록 목록으로 먼저 걸러
// 미등록이면 반드시 여기서 warn+폴백(주입된 defaultBrain 그 자체, 새로 빌드한 복사본이 아님). 미주입(구식 DI·
// 기존 테스트)이면 이 검사를 건너뛰고 기존 try/catch 경로만 탄다(회귀 0).
export class ChannelBrainResolver {
  constructor(
    private readonly resolveByName: BrainNameResolve,
    private readonly defaultBrain: BrainProvider,
    private readonly logger: PinoLogger,
    private readonly listNames?: () => string[],
  ) {}

  resolve(name: string | undefined): BrainProvider {
    if (!name) return this.defaultBrain;
    if (this.listNames && !this.listNames().includes(name)) {
      this.logger.warn(`채널 두뇌 "${name}"은 등록된 프로필이 아님(삭제됨?) — 기본으로 폴백`, 'ChannelBrainResolver');
      return this.defaultBrain;
    }
    try {
      return this.resolveByName(name);
    } catch (err) {
      this.logger.warn(`채널 두뇌 해소 실패(기본으로 폴백) "${name}": ${String(err)}`, 'ChannelBrainResolver');
      return this.defaultBrain;
    }
  }
}
