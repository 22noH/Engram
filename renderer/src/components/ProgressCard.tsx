import { useEffect, useState } from 'react';
import type { Message as Msg } from '../../../shared/protocol';
import { type ProgressRunGroup, stepLabel } from '../progress-run';
import { elapsedSec } from './Message';
import { T } from '../i18n';

// 진행 카드(목업 승인, 2026-07-25) — 한 실행 = 접힌 한 줄.
//   `⚙ <작업명> — <지금 하는 단계>          <경과> · <n>/<총>단계   ›`
// 누르면 단계 목록이 펼쳐지고, 실행이 끝나면 머리글이 `✓ <작업명> 완료 — n단계 · 총 시간`으로
// 바뀌며 자동으로 접힌다. 카드에 들어갈 내용은 전부 기록에 남은 메시지(steps)에서만 나오므로
// 앱을 껐다 켜도 그대로 복원된다.
//
// running: 이 카드가 "지금 실제로 돌고 있는" 실행인지. App이 채널의 마지막 메시지가 이 실행의
// 진행 보고인지로 판정해 내려준다(기존 activeProgressId와 같은 근거 — 답이 오거나 중지하면 꺼진다).

// 단계 마커. 성격(kind)은 서버가 스탬프한 값만 쓴다 — 문구를 뜯어보고 추측하지 않는다.
// 진행 중 카드의 마지막 단계는 아직 안 끝난 단계라 ◌, 그 앞은 전부 지나간 단계라 ✓.
function marker(m: Msg, isLast: boolean, running: boolean): { mark: string; cls: string } {
  const kind = m.progressRun?.kind;
  if (kind === 'retry') return { mark: '↻', cls: 'retry' };
  if (kind === 'fail') return { mark: '✗', cls: 'fail' };
  if (isLast && running) return { mark: '◌', cls: 'now' };
  return { mark: '✓', cls: 'ok' };
}

function hm(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function ProgressCard({ run, running }: { run: ProgressRunGroup; running: boolean }) {
  // 접힘이 기본이다(진행 메시지가 대화를 밀어내지 않는 게 이 카드의 존재 이유).
  const [open, setOpen] = useState(false);
  // 진행 중일 때만 1초 타이머 — 끝나면 정리하고 시간도 그 자리에 멈춘다.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  // 펼쳐 보던 중에 실행이 끝나면 자동으로 접는다(스펙 명시).
  useEffect(() => { if (!running) setOpen(false); }, [running]);

  const steps = run.steps;
  const first = steps[0];
  const last = steps[steps.length - 1];
  if (!first) return null;

  const sec = elapsedSec(first.ts, running ? now : new Date(last.ts).getTime());
  const total = steps.length;
  const done = running ? Math.max(0, total - 1) : total;
  const title = run.title ?? '';
  const headText = running
    ? (title ? T.progressCardTitle(title, stepLabel(last.text)) : stepLabel(last.text))
    : T.progressCardDone(title);
  const meta = running ? `${T.progressElapsed(sec)} · ${T.progressCardSteps(done, total)}` : T.progressCardDoneMeta(total, T.progressElapsed(sec));
  const toggle = (): void => setOpen((v) => !v);

  return (
    <div className={'msg progressCard ' + (running ? 'running' : 'done')} aria-busy={running || undefined}>
      <div className="who">{T.engram + ' · ' + new Date(first.ts).toLocaleTimeString()}</div>
      <div className="pcCard">
        <div className="pcHead" role="button" tabIndex={0} aria-expanded={open}
          aria-label={open ? T.progressCardCollapse : T.progressCardExpand}
          onClick={toggle}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}>
          <span className="pcIcon" aria-hidden="true">{running ? '⚙' : '✓'}</span>
          <span className="pcTitle">{headText}</span>
          <span className="pcMeta">{meta}</span>
          <span className="pcChev" aria-hidden="true">{open ? '⌄' : '›'}</span>
        </div>
        {open && (
          <div className="pcSteps">
            {steps.map((s, i) => {
              const { mark, cls } = marker(s, i === steps.length - 1, running);
              return (
                <div className={'pcStep ' + cls} key={s.id}>
                  <span className="pcMk" aria-hidden="true">{mark}</span>
                  <span className="pcTx">{stepLabel(s.text)}</span>
                  <span className="pcTm">{hm(s.ts)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
