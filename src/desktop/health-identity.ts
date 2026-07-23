// 포트 피기백 가드(플랜 docs/superpowers/plans/2026-07-24-port-piggyback-guard.md): 데스크톱이 자식
// 헬스 응답을 폴링할 때 자기가 띄운 자식인지 대조하는 순수 판정 로직만 분리(main.ts는 http 요청·
// dialog·app.quit()을 다루는 얇은 글루) — window-focus.ts와 같은 결.
//
// 판정:
// - 'ok'      : 파싱된 JSON의 instanceId가 expectedId와 일치 — 우리가 띄운 자식.
// - 'foreign' : 파싱은 됐지만 instanceId가 없거나(구버전 데몬 — 새 셸과 조합되면 외부 인스턴스와
//               구분 불가하므로 안전측으로 foreign 취급) 다름 — 다른 인스턴스가 같은 포트에 응답 중.
// - 'pending' : 파싱 불가(빈 응답·JSON 아님·본문 없음) 또는 연결 실패 — 아직 자식이 안 떴을 수도
//               있으니 계속 폴링(성급한 실패 금지).
export type HealthIdentity = 'ok' | 'foreign' | 'pending';

export function classifyHealth(body: unknown, expectedId: string): HealthIdentity {
  let parsed: unknown;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      return 'pending';
    }
  } else if (body && typeof body === 'object') {
    parsed = body;
  } else {
    return 'pending'; // undefined/null 등 — 연결 실패·본문 없음
  }
  // 배열·null 등 진짜 헬스 응답 형태(객체)가 아니면 '외부 인스턴스'로 단정하지 않고 계속 폴링한다
  // (모호한 쓰레기 응답 = pending, foreign은 "형태는 맞는데 id가 다름/없음"에만 씀).
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'pending';
  const instanceId = (parsed as Record<string, unknown>).instanceId;
  return instanceId === expectedId ? 'ok' : 'foreign';
}
