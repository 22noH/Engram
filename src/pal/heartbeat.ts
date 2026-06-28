import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import * as fs from 'fs';
import { PathResolver } from './path-resolver';

// 상주 생존신호(설계 §10.2). 1분마다 heartbeat 파일을 갱신 + pid 기록.
// @Interval이라 cli.ts 원샷(빠른 종료)에선 미발화 — 상주(main.ts)에서만 실질 동작.
@Injectable()
export class HeartbeatEmitter {
  constructor(private readonly paths: PathResolver) {}

  @Interval(60_000)
  beat(): void {
    const dir = this.paths.getStateDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.paths.getHeartbeatPath(), String(Date.now()));
    fs.writeFileSync(this.paths.getPidPath(), String(process.pid));
  }
}
