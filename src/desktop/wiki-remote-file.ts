// 설정창 폼용 wiki-remote.json 읽기/쓰기 — 구현은 knowledge-core로 옮겼다(2026-07-25).
// 이유: 같은 설정을 MCP 도구·터미널 명령(engram config)도 고칠 수 있어야 하는데 그 경로들은
// desktop 모듈을 import할 수 없다(main.ts의 readMcpWriteMode 주석 참조). 앱·AI·터미널 세 경로가
// 같은 파일을 같은 함수로 읽고 쓰게 하려면 로직이 헤드리스에서도 닿는 곳에 있어야 한다.
// 이 파일은 기존 import 경로를 깨지 않기 위한 재수출만 한다(로직 복사 0).
export {
  readWikiRemoteForm as readWikiRemoteFile,
  saveWikiRemote,
  type WikiRemoteForm,
} from '../knowledge-core/wiki/wiki-remote.config';
