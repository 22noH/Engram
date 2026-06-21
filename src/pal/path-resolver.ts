import { Injectable } from '@nestjs/common';
import * as path from 'path';

// 데이터 디렉토리(runtime/) 경로 해소기.
// 설계 §3 "코드/데이터 분리": 위키·RAG·상태가 모두 이 아래에 위치한다.
// 우선순위: 생성자 인자 > 환경변수(ENGRAM_DATA_DIR) > <cwd>/runtime.
// (배포 시 %APPDATA%/engram 등으로의 확장은 이후 단계의 책임)
@Injectable()
export class PathResolver {
  private readonly dataDir: string;

  constructor(baseDir?: string) {
    this.dataDir =
      baseDir ??
      process.env.ENGRAM_DATA_DIR ??
      path.join(process.cwd(), 'runtime');
  }

  getDataDir(): string {
    return this.dataDir;
  }

  // 위키 데이터 루트(여기서 git 이력을 관리한다).
  getWikiDir(): string {
    return path.join(this.dataDir, 'wiki');
  }

  // 위키 페이지(.md) 디렉토리.
  getWikiPagesDir(): string {
    return path.join(this.getWikiDir(), 'pages');
  }
}
