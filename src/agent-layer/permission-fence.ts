import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { Persona } from './persona-registry';

export interface FenceConfig {
  default: 'deny';
  allow: { tools: Record<string, string[]>; writePaths: string[]; denyPaths: string[] };
}

const EMPTY = (): FenceConfig => ({ default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [] } });

// 시스템 디렉터리(설정·writePaths 무관 항상 거부 백스톱). env에서 실제 경로를 해소하고
// (다른 드라이브·로캘 대비) 하드코딩 폴백을 더한다. isWithin이 슬래시/대소문자 정규화하므로 백슬래시 값도 OK.
function systemDirs(): string[] {
  const e = process.env;
  return [
    e.SystemRoot, e.windir, e.ProgramFiles, e['ProgramFiles(x86)'], e.ProgramW6432, e.ProgramData,
    'C:/Windows', 'C:/Program Files', 'C:/Program Files (x86)', 'C:/ProgramData',
  ].filter((d): d is string => !!d);
}
const SYSTEM_DENY = systemDirs();

// 도구 권한 울타리(설계 §8). 새 권한엔진 ❌ — 네이티브 권한 플래그를 산출만. default-deny.
@Injectable()
export class PermissionFence {
  private cfg: FenceConfig = EMPTY();
  // engramRoot: 설정 없이도 항상 거부되는 자기 저장소 루트(자기수정 백스톱 §9).
  constructor(private readonly configPath: string, private readonly engramRoot?: string) {}

  // 자동모드 표준 코딩 toolset — **파일 도구만**(페르소나 grant 무관).
  // Bash 제외: --add-dir는 파일 도구(Edit/Write/Read)만 가두고 샌드박스 없는 Bash는
  // 임의 셸로 울타리를 빠져나가 자기 repo·홈·시스템에 쓸 수 있다(보안 리뷰 Critical).
  // 명령 실행(테스트·빌드)은 에이전트가 아니라 VerificationGate(Engram)가 직접 한다(§8.1).
  // Bash 자율 허용은 OS 샌드박스 붙인 후속(감독/샌드박스 모드)으로 보류.
  static readonly CODING_TOOLS = ['Edit', 'Write', 'Read', 'Glob', 'Grep'];

  // 백스톱 검사: 자기 repo·시스템·config denyPaths 중 하나라도 포함이면 true.
  private isDenied(p: string): boolean {
    if (this.engramRoot && PermissionFence.isWithin(p, this.engramRoot)) return true;
    if (SYSTEM_DENY.some((d) => PermissionFence.isWithin(p, d))) return true;
    return this.cfg.allow.denyPaths.some((d) => PermissionFence.isWithin(p, d));
  }

  async load(): Promise<void> {
    try {
      this.cfg = JSON.parse(await fs.promises.readFile(this.configPath, 'utf8')) as FenceConfig;
    } catch {
      this.cfg = EMPTY(); // 없음/깨짐 → 전부 거부(안전 기본)
    }
  }

  // 경로 포함 검사(설계 §9 자기수정 차단). Windows 대소문자 무감지 + .. 정규화 후 접두사 비교.
  private static isWithin(targetPath: string, basePath: string): boolean {
    const norm = (p: string): string => path.normalize(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const t = norm(targetPath);
    const b = norm(basePath);
    return t === b || t.startsWith(b + '/');
  }

  // Claude Code 하네스 위에서 도는 두뇌만 도구 가능(진짜 Claude + 로컬LLM 백엔드).
  isHarnessBrain(brain: string): boolean {
    return !brain.startsWith('gemini') && !brain.startsWith('codex'); // ponytail: 이름 규칙 — 정밀화는 brains.json 조회로
  }

  allowedTools(persona: Persona): string[] {
    if (!this.isHarnessBrain(persona.brain)) return [];
    const granted = this.cfg.allow.tools[persona.name] ?? [];
    return persona.tools.filter((t) => granted.includes(t));
  }

  // spawn args 조각: --allowedTools + 쓰기 허용 폴더(--add-dir). denyPaths는 절대 미포함.
  spawnFlags(persona: Persona): string[] {
    const tools = this.allowedTools(persona);
    if (tools.length === 0) return [];
    const flags = ['--allowedTools', tools.join(',')];
    // denyPaths 하위까지 제외(완전일치 아님 — codingFlags·assertWritable과 동일 isWithin).
    const writes = this.cfg.allow.writePaths.filter(
      (p) => !this.cfg.allow.denyPaths.some((d) => PermissionFence.isWithin(p, d)),
    );
    for (const w of writes) flags.push('--add-dir', w);
    return flags;
  }

  // 타깃 경로 쓰기 가능 검증(설계 §9, ③). denyPaths 내거나 writePaths 밖이면 거부.
  // 자기수정·자기파괴 차단: Engram repo는 engramRoot 하드코딩 + denyPaths에도 등록 가능.
  // 쓰기 가능 검증(자동 권한 스펙). 백스톱(자기 repo·시스템) 무조건 거부 →
  // writePaths 지정 시 엄격 allowlist, 비어 있으면 자동모드(백스톱 밖 = 허용, 명시 타깃 = 동의).
  assertWritable(targetPath: string): void {
    // 하드 백스톱(설정 무관): Engram 자기 저장소 + 시스템 폴더는 절대 수정 불가.
    if (this.engramRoot && PermissionFence.isWithin(targetPath, this.engramRoot)) {
      throw new Error(`Engram 자기 저장소는 수정 불가(자기수정 차단): ${targetPath}`);
    }
    if (SYSTEM_DENY.some((d) => PermissionFence.isWithin(targetPath, d))) {
      throw new Error(`시스템 폴더는 수정 불가: ${targetPath}`);
    }
    if (this.cfg.allow.denyPaths.some((d) => PermissionFence.isWithin(targetPath, d))) {
      throw new Error(`쓰기 금지 경로(denyPaths): ${targetPath}`);
    }
    // writePaths가 지정되면 엄격 allowlist 모드. 비어있으면 자동모드 = 백스톱 밖 허용(명시 타깃 = 동의).
    if (
      this.cfg.allow.writePaths.length > 0 &&
      !this.cfg.allow.writePaths.some((w) => PermissionFence.isWithin(targetPath, w))
    ) {
      throw new Error(`허용되지 않은 경로(writePaths 밖) — runtime/config/permissions.json의 allow.writePaths에 추가하세요: ${targetPath}`);
    }
  }

  // 자동 코딩 권한 플래그(자동모드). 페르소나 grant 무관 표준 toolset + 백스톱 밖 타깃 스코프.
  // permission-mode(acceptEdits)는 CodingSpecialist가 덧붙인다.
  codingAutoFlags(writePaths: string[]): string[] {
    const flags = ['--allowedTools', PermissionFence.CODING_TOOLS.join(',')];
    for (const w of writePaths.filter((p) => !this.isDenied(p))) flags.push('--add-dir', w);
    return flags;
  }

  // API 코딩 루프용 쓰기 판정(스펙 §5.1): 백스톱 + 프로젝트 쓰기 스코프. 막히면 throw.
  // CLI는 --add-dir로 스코프를 강제하지만 API 두뇌는 이 판정을 주입받아(codeGuard) 쓴다.
  assertCodingWrite(targetPath: string, projectWritePaths: string[]): void {
    this.assertWritable(targetPath); // 백스톱(자기repo·시스템·denyPaths) + cfg writePaths
    if (
      projectWritePaths.length > 0 &&
      !projectWritePaths.some((w) => PermissionFence.isWithin(targetPath, w))
    ) {
      throw new Error(`프로젝트 쓰기 스코프 밖: ${targetPath}`);
    }
  }

}
