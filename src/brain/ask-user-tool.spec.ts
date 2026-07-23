import { askUserDef, runAskUser } from './ask-user-tool';
import { AskUserPayload } from '../agent-layer/ask-user-block';

const VALID: AskUserPayload = {
  questions: [
    { q: '어느 브랜치에 배포할까?', options: [{ label: 'main' }, { label: 'staging', desc: '테스트용' }] },
  ],
};

describe('askUserDef', () => {
  it('name=ask_user, questions 스키마(1~4문항·각 options 2~4개) shape', () => {
    const def = askUserDef();
    expect(def.name).toBe('ask_user');
    const props = def.parameters.properties as any;
    expect(props.questions.type).toBe('array');
    expect(props.questions.minItems).toBe(1);
    expect(props.questions.maxItems).toBe(4);
    const qItem = props.questions.items;
    expect(qItem.required).toEqual(['q', 'options']);
    expect(qItem.properties.options.minItems).toBe(2);
    expect(qItem.properties.options.maxItems).toBe(4);
    expect(qItem.properties.options.items.required).toEqual(['label']);
    expect((def.parameters.required as string[])).toEqual(['questions']);
  });
});

describe('runAskUser', () => {
  it('askUser 미주입 → 안내 문자열(throw 없음)', async () => {
    const out = await runAskUser(VALID);
    expect(out).toContain('ask_user');
    expect(out).toContain('쓸 수 없다');
  });

  it('입력 검증 실패 → 실패 사유 문자열, askUser는 호출되지 않는다', async () => {
    const calls: unknown[] = [];
    const askUser = async (q: AskUserPayload) => { calls.push(q); };
    const out = await runAskUser({ questions: [] }, askUser);
    expect(out).toContain('ask_user error');
    expect(calls).toHaveLength(0);
  });

  it('유효 입력 → askUser 1회 호출 + 마무리 안내 문자열 반환', async () => {
    const calls: AskUserPayload[] = [];
    const askUser = async (q: AskUserPayload) => { calls.push(q); };
    const out = await runAskUser(VALID, askUser);
    expect(calls).toEqual([VALID]);
    expect(out).toBe('질문 카드를 게시했다. 사용자의 답은 다음 사용자 메시지로 도착한다. 이번 턴은 간결히 마무리하라.');
  });

  it('askUser가 던지면 never-throw로 에러 문자열 반환', async () => {
    const askUser = async () => { throw new Error('post 실패'); };
    const out = await runAskUser(VALID, askUser);
    expect(out).toContain('ask_user error');
    expect(out).toContain('post 실패');
  });
});
