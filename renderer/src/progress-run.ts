import type { Message as Msg } from '../../shared/protocol';

// 진행 카드 묶기(2026-07-25). 자율 코딩 한 번이면 진행 보고가 10개 넘게 쌓여 대화를 밀어낸다 —
// 한 실행을 카드 하나(접힌 한 줄)로 묶어 보여주기 위한 순수 변환이다.
//
// 묶는 근거는 오직 서버가 메시지에 스탬프한 표식(m.progressRun.id)이다:
//  · 기록(jsonl)에 그대로 남으므로 앱을 껐다 켜도 같은 카드가 복원된다(휘발 상태로 묶으면 재시작
//    직후 카드가 풀려 옛 진행 메시지가 우르르 보인다 — 실제로 피하려는 사고).
//  · 실행 id가 다르면 절대 한 카드로 안 섞인다(코딩과 협업이 같은 채널에서 동시에 돌아도).
//  · 표식이 없는 옛 진행 메시지는 묶지 않는다 — 예전과 완전히 같은 한 줄로 렌더된다(회귀 0).

export interface ProgressRunGroup { kind: 'run'; id: string; title?: string; steps: Msg[] }
export type FeedItem = { kind: 'msg'; m: Msg } | ProgressRunGroup;

// 카드 안에서 쓸 단계 문구. 플랫 표시용으로 앞에 붙던 점("· ")은 카드에선 마커가 대신하므로 뗀다.
export function stepLabel(text: string): string {
  return text.replace(/^\s*·\s*/, '').trim();
}

// keepFlat: 이 메시지는 카드로 접지 말라는 예외(예: 답글이 달린 앵커 — 접으면 답글이 화면에서
// 사라진다). 미지정이면 표식이 있는 진행 보고를 전부 묶는다.
export function groupProgressRuns(msgs: Msg[], keepFlat?: (m: Msg) => boolean): FeedItem[] {
  const out: FeedItem[] = [];
  const byRun = new Map<string, ProgressRunGroup>();
  for (const m of msgs) {
    const run = m.progress ? m.progressRun : undefined;
    if (!run?.id || keepFlat?.(m)) { out.push({ kind: 'msg', m }); continue; }
    const found = byRun.get(run.id);
    if (found) {
      found.steps.push(m);
      if (!found.title && run.title) found.title = run.title;
      continue;
    }
    // 카드는 그 실행의 첫 보고가 있던 자리에 놓인다 — 대화 순서가 흐트러지지 않는다.
    const group: ProgressRunGroup = { kind: 'run', id: run.id, steps: [m], ...(run.title ? { title: run.title } : {}) };
    byRun.set(run.id, group);
    out.push(group);
  }
  return out;
}
