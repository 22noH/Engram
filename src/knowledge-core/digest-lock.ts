import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PathResolver, DEFAULT_USER } from '../pal/path-resolver';

// 크로스프로세스 다이제스트 락(설계 §11 쓰기 경합 방지).
// 수동 `engram digest`(cli.ts)와 @Cron tick(main.ts)이 같은 userId의 커서·제안 큐를
// 동시에 건드리면 중복 제안·커서 RMW 레이스가 난다. 파일 락으로 한 번에 하나만 돌게 한다.
// ponytail: 단순 파일 락 — 크래시로 남은 stale 락은 STALE_MS 경과 시 탈취. 더 정밀한
//           PID/heartbeat 감시가 필요해지면 그때. 개인 단일사용자엔 이걸로 충분.
const STALE_MS = 60 * 60 * 1000; // 1시간 — 정상 다이제스트는 이보다 훨씬 짧다

@Injectable()
export class DigestLock {
  constructor(private readonly paths: PathResolver) {}

  private lockPath(userId: string): string {
    return path.join(this.paths.getDataDir(), 'state', `digest-${userId}.lock`);
  }

  // 획득 성공 시 true. 이미 점유 중(타 프로세스 진행)이면 false.
  // 'wx' 플래그로 원자적 생성 — 경합 시 한쪽만 성공한다.
  async acquire(userId: string = DEFAULT_USER): Promise<boolean> {
    const p = this.lockPath(userId);
    await fs.mkdir(path.dirname(p), { recursive: true });
    try {
      await fs.writeFile(p, new Date().toISOString(), { flag: 'wx' });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // stale(크래시 잔여) 판정: mtime이 STALE_MS 넘으면 탈취 후 재획득.
      try {
        const st = await fs.stat(p);
        if (Date.now() - st.mtimeMs > STALE_MS) {
          await fs.rm(p, { force: true });
          await fs.writeFile(p, new Date().toISOString(), { flag: 'wx' });
          return true;
        }
      } catch {
        // stat/재생성 중 다른 프로세스와 경합 → 점유 중으로 간주
      }
      return false;
    }
  }

  async release(userId: string = DEFAULT_USER): Promise<void> {
    await fs.rm(this.lockPath(userId), { force: true });
  }
}
