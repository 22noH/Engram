import { Injectable, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import * as fs from 'fs';
import { PathResolver } from './path-resolver';

// 상주 생존신호(설계 §10.2). 기동 즉시 1회 + 1분마다 heartbeat 파일을 갱신 + pid 기록.
// 즉시 1회가 없으면 재시작 후 60초간 이전 박동이 남아 상태 표시(데스크톱 설정창)가 오해를 부른다.
// @Interval이라 cli.ts 원샷(빠른 종료)에선 미발화 — 상주(main.ts)에서만 실질 동작.
@Injectable()
export class HeartbeatEmitter implements OnModuleInit {
  constructor(private readonly paths: PathResolver) {}

  onModuleInit(): void {
    // 상주 진입점(main.ts)에서만 즉시 발화. CLI 원샷이 beat하면 죽은 상주의 pid를 덮어써
    // watchdog을 오도하므로(빠른 종료 프로세스의 pid가 기록됨) 플래그로 구분한다.
    if (process.env.ENGRAM_RESIDENT === '1') this.beat();
  }

  @Interval(60_000)
  beat(): void {
    const dir = this.paths.getStateDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.paths.getHeartbeatPath(), String(Date.now()));
    fs.writeFileSync(this.paths.getPidPath(), String(process.pid));
  }
}
