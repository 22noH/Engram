import { execFileSync } from 'child_process';

// 고아 Engram 백엔드 자가 치유(실사고 2026-07-24, 새 설치 머신 영구 잠금):
// 예전 버전이 종료될 때 detached 백엔드(utilityProcess)가 살아남아 포트를 영원히 점유하면,
// 이후 모든 실행이 '다른 인스턴스' 판정 → 즉시 종료의 무한 루프에 갇힌다(재설치로도 안 풀림 —
// 설치기는 창 있는 프로세스만 정리). 해법: foreign 판정 시 포트 점유자가 Engram.exe(우리 자신의
// 잔재)면 자동으로 트리킬하고 한 번 재시도한다. 남의 프로그램이면 절대 죽이지 않는다(안내 유지).

// `netstat -ano -p tcp` 출력에서 해당 포트를 LISTENING 중인 PID들을 뽑는다(파싱만 — 순수 함수).
export function parseListeningPids(netstatOut: string, port: number): number[] {
  const pids = new Set<number>();
  for (const line of netstatOut.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    // 예: "  TCP    127.0.0.1:47800    0.0.0.0:0    LISTENING    27852"
    const m = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (m && Number(m[1]) === port) pids.add(Number(m[2]));
  }
  return [...pids];
}

// `tasklist /FI "PID eq N" /FO CSV /NH` 출력에서 이미지 이름을 뽑는다. 예: "Engram.exe","27852",...
export function parseImageName(tasklistCsvOut: string): string | null {
  const m = tasklistCsvOut.match(/^"([^"]+)"/m);
  return m ? m[1] : null;
}

// win32 전용. 포트 점유자가 Engram.exe면 트리킬. 죽인 게 하나라도 있으면 true.
// never-throw — 실패는 로그 콜백으로만 알린다.
export function killOrphanEngramOnPort(port: number, log: (msg: string) => void): boolean {
  if (process.platform !== 'win32') return false;
  let killed = false;
  try {
    const netstat = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
    const pids = parseListeningPids(netstat, port);
    log(`orphan-cleanup: port ${port} listeners = [${pids.join(', ')}]`);
    for (const pid of pids) {
      if (pid === process.pid) continue; // 자기 자신 보호(있을 수 없지만 안전측)
      let image: string | null = null;
      try {
        const csv = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
        image = parseImageName(csv);
      } catch { /* 조회 실패 = 미상 → 안 죽임 */ }
      if (image !== 'Engram.exe') { log(`orphan-cleanup: pid ${pid} image=${image ?? 'unknown'} — 남의 프로세스, 미개입`); continue; }
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        killed = true;
        log(`orphan-cleanup: killed orphan Engram backend pid ${pid} (tree)`);
      } catch (e) {
        log(`orphan-cleanup: taskkill pid ${pid} failed: ${String(e)}`);
      }
    }
  } catch (e) {
    log(`orphan-cleanup: netstat failed: ${String(e)}`);
  }
  return killed;
}
