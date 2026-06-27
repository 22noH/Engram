import { VerificationGate } from './verification-gate';

describe('VerificationGate', () => {
  const gate = new VerificationGate();
  const ok = 'node -e "process.exit(0)"';
  const fail = 'node -e "process.exit(1)"';

  it('전부 0이면 pass', async () => {
    const r = await gate.run(process.cwd(), { typecheck: ok, build: ok, test: ok });
    expect(r).toMatchObject({ pass: true, failed: null });
  });
  it('typecheck 실패면 거기서 멈춤', async () => {
    const r = await gate.run(process.cwd(), { typecheck: fail, build: ok, test: ok });
    expect(r).toMatchObject({ pass: false, failed: 'typecheck' });
  });
  it('test만 실패', async () => {
    const r = await gate.run(process.cwd(), { typecheck: ok, build: ok, test: fail });
    expect(r).toMatchObject({ pass: false, failed: 'test' });
  });
});
