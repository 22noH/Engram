import {
  confirmWikiSave,
  declinedText,
  disableElicitation,
  isElicitationDisabled,
  saveConfirmParams,
  saveConfirmMessage,
  DEFAULT_ELICIT_TIMEOUT_MS,
  ELICIT_OFF_ENV,
  ELICIT_TIMEOUT_ENV,
  WikiSaveRequest,
} from './mcp-elicit';

type FakeServer = {
  getClientCapabilities: jest.Mock;
  elicitInput: jest.Mock;
};

function fakeServer(caps: unknown, elicit?: jest.Mock): FakeServer {
  return {
    getClientCapabilities: jest.fn().mockReturnValue(caps),
    elicitInput: elicit ?? jest.fn(),
  };
}

const REQ: WikiSaveRequest = { title: 'My Page', content: 'body '.repeat(200), op: 'propose' };

describe('confirmWikiSave — capability 협상', () => {
  it('클라이언트가 elicitation 미선언 → 요청조차 안 하고 unavailable(기존 경로)', async () => {
    const s = fakeServer({ roots: {} });
    await expect(confirmWikiSave(s, REQ, {})).resolves.toBe('unavailable');
    expect(s.elicitInput).not.toHaveBeenCalled();
  });

  it('capabilities 자체가 undefined(초기화 전) → unavailable', async () => {
    const s = fakeServer(undefined);
    await expect(confirmWikiSave(s, REQ, {})).resolves.toBe('unavailable');
    expect(s.elicitInput).not.toHaveBeenCalled();
  });

  it('url 모드만 선언 → form 미지원이므로 요청 안 함(SDK throw 회피)', async () => {
    const s = fakeServer({ elicitation: { url: {} } });
    await expect(confirmWikiSave(s, REQ, {})).resolves.toBe('unavailable');
    expect(s.elicitInput).not.toHaveBeenCalled();
  });

  it('form 선언 → 실제로 elicitInput 호출', async () => {
    const elicit = jest.fn().mockResolvedValue({ action: 'accept', content: { decision: 'save' } });
    const s = fakeServer({ elicitation: { form: {} } }, elicit);
    await expect(confirmWikiSave(s, REQ, {})).resolves.toBe('accept');
    expect(elicit).toHaveBeenCalledTimes(1);
  });
});

describe('confirmWikiSave — 승인/거부', () => {
  const caps = { elicitation: { form: {} } };

  it('accept + decision:save → accept', async () => {
    const s = fakeServer(caps, jest.fn().mockResolvedValue({ action: 'accept', content: { decision: 'save' } }));
    await expect(confirmWikiSave(s, REQ, {})).resolves.toBe('accept');
  });

  it('accept + decision:cancel → decline(저장 안 함)', async () => {
    const s = fakeServer(caps, jest.fn().mockResolvedValue({ action: 'accept', content: { decision: 'cancel' } }));
    await expect(confirmWikiSave(s, REQ, {})).resolves.toBe('decline');
  });

  it('accept인데 content 없음(느슨한 클라이언트) → accept로 해석', async () => {
    const s = fakeServer(caps, jest.fn().mockResolvedValue({ action: 'accept' }));
    await expect(confirmWikiSave(s, REQ, {})).resolves.toBe('accept');
  });

  it('action:decline → decline', async () => {
    const s = fakeServer(caps, jest.fn().mockResolvedValue({ action: 'decline' }));
    await expect(confirmWikiSave(s, REQ, {})).resolves.toBe('decline');
  });

  it('action:cancel(대화상자 닫음) → decline', async () => {
    const s = fakeServer(caps, jest.fn().mockResolvedValue({ action: 'cancel' }));
    await expect(confirmWikiSave(s, REQ, {})).resolves.toBe('decline');
  });
});

describe('confirmWikiSave — 실패·타임아웃 폴백(무한대기 금지)', () => {
  const caps = { elicitation: { form: {} } };

  it('elicitInput이 throw(타임아웃 포함) → unavailable(기존 경로, never-throw)', async () => {
    const s = fakeServer(caps, jest.fn().mockRejectedValue(new Error('MCP error -32001: Request timed out')));
    await expect(confirmWikiSave(s, REQ, {})).resolves.toBe('unavailable');
  });

  it('타임아웃을 반드시 지정한다(기본 120초, 진행알림으로 연장 금지)', async () => {
    const elicit = jest.fn().mockResolvedValue({ action: 'accept', content: { decision: 'save' } });
    const s = fakeServer(caps, elicit);
    await confirmWikiSave(s, REQ, {});
    expect(elicit.mock.calls[0][1]).toMatchObject({
      timeout: DEFAULT_ELICIT_TIMEOUT_MS,
      resetTimeoutOnProgress: false,
    });
  });

  it(`${ELICIT_TIMEOUT_ENV}로 타임아웃 조정 가능`, async () => {
    const elicit = jest.fn().mockResolvedValue({ action: 'accept' });
    const s = fakeServer(caps, elicit);
    await confirmWikiSave(s, REQ, { [ELICIT_TIMEOUT_ENV]: '50' });
    expect(elicit.mock.calls[0][1]).toMatchObject({ timeout: 50 });
  });

  it('잘못된 타임아웃 env(0·문자열) → 기본값', async () => {
    const elicit = jest.fn().mockResolvedValue({ action: 'accept' });
    const s = fakeServer(caps, elicit);
    await confirmWikiSave(s, REQ, { [ELICIT_TIMEOUT_ENV]: 'nope' });
    await confirmWikiSave(s, REQ, { [ELICIT_TIMEOUT_ENV]: '0' });
    expect(elicit.mock.calls[0][1]).toMatchObject({ timeout: DEFAULT_ELICIT_TIMEOUT_MS });
    expect(elicit.mock.calls[1][1]).toMatchObject({ timeout: DEFAULT_ELICIT_TIMEOUT_MS });
  });

  it(`${ELICIT_OFF_ENV}=1 → 사람 없는 맥락 탈출구, 요청 안 함`, async () => {
    const s = fakeServer(caps);
    await expect(confirmWikiSave(s, REQ, { [ELICIT_OFF_ENV]: '1' })).resolves.toBe('unavailable');
    expect(s.elicitInput).not.toHaveBeenCalled();
  });

  it('disableElicitation된 서버(stateless HTTP) → 요청 안 함', async () => {
    const s = fakeServer(caps);
    expect(isElicitationDisabled(s)).toBe(false);
    disableElicitation(s);
    expect(isElicitationDisabled(s)).toBe(true);
    await expect(confirmWikiSave(s, REQ, {})).resolves.toBe('unavailable');
    expect(s.elicitInput).not.toHaveBeenCalled();
  });
});

describe('요청 스키마·문구', () => {
  it('저장/취소 두 선택지의 enum 스키마', () => {
    const p = saveConfirmParams(REQ);
    expect(p.mode).toBe('form');
    const decision = p.requestedSchema.properties.decision as { enum: string[]; enumNames: string[] };
    expect(decision.enum).toEqual(['save', 'cancel']);
    expect(decision.enumNames).toEqual(['Save', 'Cancel']);
    expect(p.requestedSchema.required).toEqual(['decision']);
  });

  it('메시지에 제목·대상(새 페이지)·내용 앞부분', () => {
    const msg = saveConfirmMessage({ title: 'Deploy Steps', content: 'first line body', op: 'propose' });
    expect(msg).toContain('Deploy Steps');
    expect(msg).toContain('new page');
    expect(msg).toContain('first line body');
  });

  it('slug 지정 → 기존 페이지에 추가한다고 밝힌다', () => {
    const msg = saveConfirmMessage({ title: 'T', content: 'c', slug: 'deploy-steps', op: 'propose' });
    expect(msg).toContain('deploy-steps');
    expect(msg.toLowerCase()).toContain('append');
  });

  it('긴 내용은 미리보기로 절단', () => {
    const msg = saveConfirmMessage({ title: 'T', content: 'x'.repeat(5000), op: 'propose' });
    expect(msg.length).toBeLessThan(1000);
    expect(msg).toContain('…');
  });

  it('wiki_write는 즉시 게시임을 밝힌다', () => {
    expect(saveConfirmMessage({ title: 'T', content: 'c', op: 'write' })).toContain('now');
  });

  it('거부 결과 텍스트는 제목과 "아무것도 저장 안 됨"을 담는다', () => {
    expect(declinedText(REQ)).toContain('My Page');
    expect(declinedText(REQ).toLowerCase()).toContain('declined');
    expect(declinedText({ ...REQ, op: 'write' }).toLowerCase()).toContain('written');
  });
});
