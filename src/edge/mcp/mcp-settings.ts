import {
  applySettingChange, defaultPlanContext, formatSetting, formatSettings, listSettings, planSettingChange,
  readSetting, unknownKeyError, type PlanContext, type SettingPlan, type SettingPlanOk,
} from '../settings-registry';

// MCP 경로(=AI에게 말로 설정 바꾸기)의 어댑터. 계산은 전부 settings-registry.ts(단일 출처)에
// 위임하고, 여기선 "MCP 도구가 부를 수 있는 모양"으로만 감싼다(mcp-proposals.ts와 같은 관례).
// 승인 게이트(elicitation)는 server 핸들이 필요해서 engram-mcp.ts가 건다 — 이 포트는 순수하다.

export interface McpSettingsPort {
  /** 전체 목록(사람이 읽는 텍스트). */
  view(): string;
  /** 한 항목 상세. 모르는 key면 null. */
  viewOne(key: string): string | null;
  /** 원시 값(코드가 분기용으로 읽을 때). 모르는 key·미설정이면 빈 문자열. */
  read(key: string): string;
  /** 검증·위험도 분류(파일 안 건드림). */
  plan(key: string, value: string): SettingPlan;
  /** 실제 저장(승인 판정 후 호출). */
  apply(plan: SettingPlanOk): string;
}

export function makeMcpSettings(configDir: string, ctx: PlanContext = defaultPlanContext(configDir)): McpSettingsPort {
  return {
    view: () => formatSettings(listSettings(configDir)),
    viewOne: (key) => {
      const v = readSetting(configDir, key);
      return v ? formatSetting(v) : null;
    },
    read: (key) => readSetting(configDir, key)?.value ?? '',
    plan: (key, value) => planSettingChange(configDir, key, value, ctx),
    apply: (plan) => applySettingChange(configDir, plan),
  };
}

export { unknownKeyError };
