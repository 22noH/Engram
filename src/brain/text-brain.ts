import spawn from 'cross-spawn';
import { BrainResult } from './brain.port';
import { BrainProfile } from './brain.config';

// 하네스 없는 CLI(Gemini/Codex) 공유 spawn(설계 §6.2). stdout 텍스트를 BrainResult로 정규화.
// timeout·spawn-error·settled-once 가드. ClaudeCliBrain은 stream-json 파싱이 달라 별도 유지.
export function spawnTextBrain(
  profile: BrainProfile,
  args: string[],
  onChunk?: (text: string) => void,
): Promise<BrainResult> {
  return new Promise<BrainResult>((resolve) => {
    const child = spawn(profile.cli, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...profile.env },
    });

    let text = '';
    let settled = false;

    const finish = (r: BrainResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(r);
    };

    const timer = setTimeout(
      () => finish({ text, costUsd: 0, isError: true, raw: 'timeout' }),
      profile.timeoutMs,
    );

    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString();
      text += s;
      onChunk?.(s);
    });

    child.on('error', () => finish({ text: '', costUsd: 0, isError: true, raw: 'spawn-error' }));
    child.on('close', (code: number) => finish({ text, costUsd: 0, isError: code !== 0 }));
  });
}
