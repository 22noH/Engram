import { groupProgressRuns, stepLabel } from './progress-run';
import type { Message as Msg } from '../../shared/protocol';

// 진행 카드 묶기 — 순수 함수. 화면 상태가 아니라 "기록에 남은 표식"만 보고 묶기 때문에 앱을 껐다
// 켜도(= 같은 jsonl을 다시 읽어도) 정확히 같은 카드가 나온다. 이 파일이 그 계약을 못 박는다.

let n = 0;
const msg = (over: Partial<Msg> = {}): Msg => ({
  id: `m${++n}`, authorId: 'engram', text: 't', ts: new Date().toISOString(), ...over,
} as Msg);
const step = (runId: string, over: Partial<Msg> = {}): Msg =>
  msg({ progress: true, progressRun: { id: runId, title: '자율 코딩' }, ...over });

describe('groupProgressRuns', () => {
  it('같은 실행의 연속된 진행 보고를 카드 하나로 묶는다', () => {
    const items = groupProgressRuns([msg(), step('r1'), step('r1'), step('r1'), msg()]);
    expect(items.map((i) => i.kind)).toEqual(['msg', 'run', 'msg']);
    const run = items[1] as any;
    expect(run.steps).toHaveLength(3);
    expect(run.title).toBe('자율 코딩');
    expect(run.id).toBe('r1');
  });

  it('다른 실행은 절대 섞이지 않는다 — 번갈아 와도 각자 카드로 간다', () => {
    const items = groupProgressRuns([step('r1'), step('r2'), step('r1'), step('r2')]);
    const runs = items.filter((i) => i.kind === 'run') as any[];
    expect(runs).toHaveLength(2);
    expect(runs[0].id).toBe('r1');
    expect(runs[0].steps).toHaveLength(2);
    expect(runs[1].steps).toHaveLength(2);
  });

  it('같은 기록을 다시 읽으면(재시작) 완전히 같은 묶음이 나온다 — 휘발 상태 의존 0', () => {
    const history = [msg(), step('r1'), step('r1'), msg({ text: '완료' })];
    const first = JSON.stringify(groupProgressRuns(history));
    const afterRestart = JSON.stringify(groupProgressRuns(JSON.parse(JSON.stringify(history))));
    expect(afterRestart).toBe(first);
  });

  it('일반 메시지가 사이에 껴도 같은 실행이면 한 카드로 이어붙인다(실행이 안 끝났다는 뜻)', () => {
    const items = groupProgressRuns([step('r1'), msg({ text: '사용자 말' }), step('r1')]);
    const runs = items.filter((i) => i.kind === 'run') as any[];
    expect(runs).toHaveLength(1);
    expect(runs[0].steps).toHaveLength(2);
  });

  it('카드 표식이 없는 옛 진행 메시지는 묶지 않는다(예전 그대로 한 줄씩 — 회귀 0)', () => {
    const items = groupProgressRuns([msg({ progress: true }), msg({ progress: true })]);
    expect(items.map((i) => i.kind)).toEqual(['msg', 'msg']);
  });

  it('진행 표시가 아예 없는 보통 대화는 그대로 흘러간다(회귀 0)', () => {
    const items = groupProgressRuns([msg(), msg(), msg()]);
    expect(items.map((i) => i.kind)).toEqual(['msg', 'msg', 'msg']);
  });

  it('답글이 달린 메시지는 카드로 접지 않는다(스레드 답글이 사라지면 안 된다)', () => {
    const anchored = step('r1');
    const items = groupProgressRuns([anchored, step('r1')], (m) => m.id === anchored.id);
    expect(items[0].kind).toBe('msg');
    expect((items[1] as any).steps).toHaveLength(1);
  });
});

describe('stepLabel', () => {
  it('플랫 표시용 앞머리 점을 떼어낸다(카드에선 마커가 그 자리를 대신한다)', () => {
    expect(stepLabel('· 코딩 중: backend')).toBe('코딩 중: backend');
    expect(stepLabel('  ✓ 착지: backend')).toBe('✓ 착지: backend');
    expect(stepLabel('분해 완료')).toBe('분해 완료');
  });
});
