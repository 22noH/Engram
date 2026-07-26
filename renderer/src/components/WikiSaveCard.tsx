import type { WikiSaveAsk } from '../../../shared/protocol';
import { T } from '../i18n';

// 위키 저장 확인 카드(목업 B, 2026-07-26 승인) — 앱이 떠 있는 동안의 모든 저장 경로가 이걸로 묻는다.
// 순수 프레젠테이션: 답은 onAnswer로만 올려보내고, 카드를 거두는 건 서버의 wikiSaveDone이 한다
// (다른 창에서 눌렀거나 타임아웃된 경우까지 한 곳에서 정리 — 유령 카드 방지).
export function WikiSaveCard(props: {
  ask: WikiSaveAsk;
  onAnswer: (id: string, decision: 'save' | 'cancel') => void;
}) {
  const { ask } = props;
  const kb = ask.bytes < 1024 ? `${ask.bytes} B` : `${(ask.bytes / 1024).toFixed(1)} KB`;
  return (
    <div id="wikiSaveCard">
      <div className="wsHead">
        <span className="eyebrow">{T.wikiSaveEyebrow}</span>
        <span className="wsBadge">{ask.targetSlug ? T.wikiSaveAppend : T.wikiSaveNew}</span>
      </div>
      <div className="wsTitle">{ask.title}</div>
      <div className="wsMeta">{(ask.targetSlug ? T.wikiSaveTargetAppend(ask.targetSlug) : T.wikiSaveTargetNew) + ' · ' + kb}</div>
      <div className="wsPreview">{ask.preview}</div>
      <div className="wsActions">
        <button type="button" className="wsSave" onClick={() => props.onAnswer(ask.id, 'save')}>{T.wikiSaveConfirm}</button>
        <button type="button" onClick={() => props.onAnswer(ask.id, 'cancel')}>{T.wikiSaveCancel}</button>
      </div>
    </div>
  );
}
