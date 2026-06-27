import { Injectable } from '@nestjs/common';
import * as path from 'path';

// 단일사용자 기본 네임스페이스(설계 §15 wiki/pages/{userId}). 멀티유저는 userId를 명시.
export const DEFAULT_USER = 'default';

// 데이터 디렉토리(runtime/) 경로 해소기.
// 설계 §3 "코드/데이터 분리": 위키·RAG·상태가 모두 이 아래에 위치한다.
// 우선순위: 생성자 인자 > 환경변수(ENGRAM_DATA_DIR) > <cwd>/runtime.
// (배포 시 %APPDATA%/engram 등으로의 확장은 이후 단계의 책임)
@Injectable()
export class PathResolver {
  private readonly dataDir: string;

  constructor(baseDir?: string) {
    // ENGRAM_DATA_DIR는 생성 시점(DI 해소 시)에 1회 읽는다. 이후 환경변수 변경은 반영되지 않음.
    this.dataDir =
      baseDir ??
      process.env.ENGRAM_DATA_DIR ??
      path.join(process.cwd(), 'runtime');
  }

  // 데이터 루트 디렉토리 경로를 반환한다.
  getDataDir(): string {
    return this.dataDir;
  }

  // 위키 데이터 루트(여기서 git 이력을 관리한다).
  getWikiDir(): string {
    return path.join(this.dataDir, 'wiki');
  }

  // 위키 페이지(.md) 디렉토리. 멀티유저 네임스페이스 wiki/pages/{userId}/ (설계 §15).
  getWikiPagesDir(userId: string = DEFAULT_USER): string {
    return path.join(this.getWikiDir(), 'pages', userId);
  }

  // 구조화 로그(pino) 디렉토리.
  getLogsDir(): string {
    return path.join(this.dataDir, 'logs');
  }

  // RAG 벡터 저장소(LanceDB) 루트.
  getRagDir(): string {
    return path.join(this.dataDir, 'rag');
  }

  // 설정(brains.json 등) 디렉토리(설계 §15 runtime/config).
  getConfigDir(): string {
    return path.join(this.dataDir, 'config');
  }

  // 공유 상태(TaskStore 등) 디렉토리(설계 §15 runtime/state).
  getStateDir(): string {
    return path.join(this.dataDir, 'state');
  }
}
