import { Injectable, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import * as fs from 'fs';
import { PathResolver } from './path-resolver';

// 상주 생존신호(설계 §10.2). 기동 즉시 1회 + 1분마다 heartbeat 파일을 갱신 + pid 기록.
// 즉시 1회가 없으면 재시작 후 60초간 이전 박동이 남아 상태 표시(데스크톱 설정창)가 오해를 부른다.
// cli.ts 원샷(빠른 종료)은 @Interval 발화 전에 종료돼 무해하지만, 헤드리스 MCP(mcp-headless.ts)처럼
// ENGRAM_RESIDENT 없이 "장수명"으로 떠 있는 프로세스는 60초를 넘기면 주기 tick이 실제로 발화한다
// — 그 경우도 heartbeat/pid를 건드리면 같은 데이터 dir을 공유하는 진짜 상주가 없는데도 watchdog.ts·
// 데스크톱 status.ts가 "살아있음"으로 오판한다(watchdog은 멎은 진짜 상주 감지를 놓침). 그래서 즉시
// 발화뿐 아니라 주기 tick도 ENGRAM_RESIDENT로 게이트한다 — beat() 자체는 무조건 쓰기(직접 호출·테스트용).
@Injectable()
export class HeartbeatEmitter implements OnModuleInit {
  constructor(private readonly paths: PathResolver) {}

  onModuleInit(): void {
    // 상주 진입점(main.ts)에서만 즉시 발화. CLI 원샷이 beat하면 죽은 상주의 pid를 덮어써
    // watchdog을 오도하므로(빠른 종료 프로세스의 pid가 기록됨) 플래그로 구분한다.
    if (process.env.ENGRAM_RESIDENT === '1') this.beat();
  }

  // 주기 발화 — 상주 플래그가 없으면(cli.ts 원샷·헤드리스 MCP 등) 무발화. ★위 주석 참조.
  @Interval(60_000)
  tick(): void {
    if (process.env.ENGRAM_RESIDENT === '1') this.beat();
  }

  beat(): void {
    const dir = this.paths.getStateDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.paths.getHeartbeatPath(), String(Date.now()));
    fs.writeFileSync(this.paths.getPidPath(), String(process.pid));
  }
}
