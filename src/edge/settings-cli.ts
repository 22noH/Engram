import {
  applySettingChange, defaultPlanContext, formatSetting, formatSettings, listSettings, planSettingChange,
  readSetting, unknownKeyError, WRITABLE_SETTING_KEYS, type PlanContext,
} from './settings-registry';

// `engram config get|set` — 설정을 바꾸는 세 경로 중 **터미널** 경로(스크립트·자동화용).
// 계산·검증은 전부 settings-registry.ts(단일 출처)에 위임하고 여기선 argv 파싱과 출력 포맷만 한다
// (server-cli.ts의 관례와 동일 — 로직 중복 0).
//
// ★위험 설정도 터미널에선 그대로 실행된다: 이 명령을 친 것 자체가 사람의 결정이기 때문.
// 대신 무엇이 왜 위험한지 한 줄 경고를 반드시 함께 출력한다(AI 경로는 elicitation 대화상자가
// 그 역할을 한다 — edge/mcp/mcp-settings.ts).

export const CONFIG_USAGE = `사용법: engram config <get|set> [key] [value]
  config get [key]            현재 설정 보기(key 생략 시 전체)
  config set <key> <value>    설정 변경
  변경 가능한 key: ${WRITABLE_SETTING_KEYS.join(', ')}
`;

export interface ConfigCommandResult { output: string; exitCode: number }

export function runSettingsCommand(
  args: string[],
  configDir: string,
  ctx: PlanContext = defaultPlanContext(configDir),
): ConfigCommandResult {
  const [sub, key, ...rest] = args;

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    return { output: CONFIG_USAGE, exitCode: 0 };
  }

  if (sub === 'get' || sub === 'list') {
    if (!key) return { output: `${formatSettings(listSettings(configDir))}\n`, exitCode: 0 };
    const view = readSetting(configDir, key);
    if (!view) return { output: `${unknownKeyError(key)}\n`, exitCode: 1 };
    return { output: `${formatSetting(view)}\n`, exitCode: 0 };
  }

  if (sub === 'set') {
    if (!key) return { output: CONFIG_USAGE, exitCode: 1 };
    // 값에 공백이 있어도(윈도우 폴더 경로) 따옴표 없이 동작하게 나머지 인자를 이어 붙인다.
    const value = rest.join(' ');
    if (value === '') {
      return { output: `값이 필요합니다. 예: engram config set ${key} <value>\n`, exitCode: 1 };
    }
    const plan = planSettingChange(configDir, key, value, ctx);
    if (!plan.ok) return { output: `${plan.error}\n`, exitCode: 1 };
    if (plan.unchanged) return { output: `변경 없음 — ${plan.key}는 이미 그 값입니다.\n`, exitCode: 0 };
    const summary = applySettingChange(configDir, plan);
    const warn = plan.risk === 'danger' ? `경고: ${plan.reason}\n` : '';
    return { output: `${warn}${summary}\n`, exitCode: 0 };
  }

  return { output: `알 수 없는 하위 명령: ${sub}\n${CONFIG_USAGE}`, exitCode: 1 };
}
