import { askBrainDef, runAskBrain } from './brain-tools';
import { DelegateHandle } from './brain.port';

describe('askBrainDef', () => {
  it('이름이 ask_brain이고 설명에 두뇌 목록이 들어간다', () => {
    const d = askBrainDef(['claude', 'ollama']);
    expect(d.name).toBe('ask_brain');
    expect(d.description).toContain('claude');
    expect(d.description).toContain('ollama');
    expect((d.parameters as any).required).toEqual(['brain', 'task']);
  });
});

describe('runAskBrain (never-throw)', () => {
  const delegate: DelegateHandle = { brains: ['x'], run: async (b, t) => `ran ${b}: ${t}` };
  it('정상 인자는 delegate.run으로 라우팅', async () => {
    expect(await runAskBrain({ brain: 'x', task: 'do it' }, delegate)).toBe('ran x: do it');
  });
  it('delegate 없으면 에러 텍스트', async () => {
    expect(await runAskBrain({ brain: 'x', task: 't' })).toContain('not available');
  });
  it('인자 오염은 에러 텍스트(throw 아님)', async () => {
    expect(await runAskBrain({ brain: 1, task: 't' }, delegate)).toContain('required');
    expect(await runAskBrain(null, delegate)).toContain('required');
  });
  it('delegate.run이 던져도 에러 텍스트로 삼킨다(자체 never-throw)', async () => {
    const bad: DelegateHandle = { brains: ['x'], run: async () => { throw new Error('boom'); } };
    expect(await runAskBrain({ brain: 'x', task: 't' }, bad)).toContain('boom');
  });
});
