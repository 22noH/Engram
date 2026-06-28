export type ServiceStatus = 'running' | 'stopped' | 'not-installed';

// OS 서비스 등록 추상(설계 §10.1). OS별 어댑터가 구현.
export interface SupervisorPort {
  install(): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<ServiceStatus>;
}

// 서비스 등록에 필요한 정보. CLI가 채워 팩토리에 넘긴다.
export interface ServiceSpec {
  name: string;        // 서비스 이름(예: 'Engram')
  scriptPath: string;  // 상주 진입점 절대경로(dist/src/main.js)
  dataDir: string;     // ENGRAM_DATA_DIR로 주입할 데이터 루트
}
