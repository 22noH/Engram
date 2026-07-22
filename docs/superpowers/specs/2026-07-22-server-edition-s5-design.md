# 서버 에디션 S5 — 배포(engram-server CLI + 윈도우 서비스 + 도커) 설계

날짜: 2026-07-22 · 상태: 사용자 승인됨(윈도우 서비스 + 방화벽 + 풀 CLI 파리티 + 도커).
선행: `docs/superpowers/specs/2026-07-19-server-edition-design.md`(§2.1 데몬 설치·§2.3 CLI 방향) · 서버 콘솔 S1~S4 완료(웹 콘솔 `/admin`).

## 1. 목적

헤드리스 데몬(기존 `node dist/src/main.js`)을 **한 명령으로 상주 서버화**하고, 웹 콘솔과 동등한 **터미널 관리(SSH·자동화)**를 제공한다. 배포 3방식: 윈도우 서비스 · 도커 · 수동 실행.

## 2. 구성 요소

### 2.1 `engram-server` CLI (신규 bin → `dist/src/server-cli.js`)

- 서버 머신에서 도는 관리 도구 → **데이터 폴더에 파일시스템 직접 접근**(HTTP 클라이언트 아님). admin-http가 쓰는 **바로 그 스토어/헬퍼를 재사용**(account-store·session-store·group-store·chat.config·preset-file·brains-file·path-resolver·schedules-file). 로직 중복 0, 웹 콘솔과 완전 동등.
- 인자 파싱은 신규 의존성 없이 `process.argv` 수동 파싱(기존 관례 — cli.ts). 서브커맨드 디스패치.
- 명령(웹 콘솔 파리티):
  - `setup` — 1회용 셋업 코드 생성/표시(state/setup-code). 이미 owner 있으면 안내만.
  - `status` — 가동(process/heartbeat 파일)·마지막 하트비트·포트 리슨 여부·용량(chat/wiki+rag 바이트)·멤버/채널 수. 실행 중 상태는 heartbeat 파일 + 포트 접속으로 읽는다.
  - `user list | approve <id> | suspend <id> | reset-password <id>` — account-store 직접(콘솔 멤버 API와 동일 동작; reset은 임시 비번 출력).
  - `group list | create <name> [--perm ...] | delete <id>` — group-store 직접.
  - `config get [key] | set <key> <value>` — chat.config(포트·바인드·보존[retention]·autoCompact)·코딩 허용(permissions-file). 검증은 admin-http와 동일 규칙 재사용. 재시작 적용 필드는 안내 출력.
  - `preset export [path]` — preset.json 생성(preset-file 재사용). 기본 경로 안내.
  - `start` — 포그라운드로 데몬 실행(서비스 없이 그냥 띄우기 — 도커/디버깅용). 내부적으로 main 부트.
  - `service install | uninstall | start | stop | status` — 윈도우 서비스(§2.2).
- 출력은 사람이 읽는 텍스트(+ `--json` 있으면 JSON — 자동화용, 있으면 좋고 없어도 됨=최소).
- 권한: 로컬 파일 접근이므로 OS 파일 권한이 게이트(서버 머신 관리자만 실행). 셋업 코드/owner 개념은 웹 콘솔 원격 접근용 그대로 유지.

### 2.2 윈도우 서비스 (node-windows, 이미 dependency)

- `engram-server service install` → node-windows `Service`로 `node dist/src/main.js`를 서비스 등록. 서비스 env에 서버 설정(ENGRAM_CHAT_BIND·ENGRAM_CHAT_PORT 등, config에서 읽어 주입). 부팅 자동시작·크래시 자동재시작(winsw 기본).
- **방화벽 규칙**: 설치 시 `netsh advfirewall firewall add rule`로 그 포트 인바운드 TCP 허용(규칙 이름 고정 — uninstall이 같은 이름으로 제거). 관리자 권한 필요 안내(elevate).
- `uninstall` → 서비스 제거 + 방화벽 규칙 삭제(둘 다 멱등 — 없으면 조용히 통과).
- `service start|stop|status` → 서비스 제어/상태.
- 비윈도우에서 `service *` 호출 시 "윈도우 전용, 도커/systemd 안내" 메시지(크래시 아님).

### 2.3 도커

- `Dockerfile` — node-slim 베이스, `dist/`·`node_modules`(prod)·`prompts/`·필요한 자산 복사, 포트 EXPOSE, `CMD ["node","dist/src/main.js"]`. 데이터 폴더는 env(ENGRAM_DATA_DIR)로 볼륨 지점.
- `docker-compose.yml` — 데이터 볼륨 마운트·포트 매핑(예: 47800)·env(bind=0.0.0.0)·`restart: unless-stopped`(도커식 자동시작). 첫 실행 셋업 코드는 컨테이너 로그로 출력.
- 임베딩 모델 다운로드(수백 MB)는 볼륨에 캐시되게 안내.

### 2.4 문서

- README 서버 에디션 섹션에 **3방식**(윈도우 서비스 / 도커 / 수동 `node dist/src/main.js`) + CLI 명령 표 + 방화벽·인터넷 공개(TLS 리버스 프록시) 안내.

## 3. 안전·비범위

- 셋업 코드 1회용·owner 게이트 기존 유지. CLI는 로컬 관리자 신뢰(파일 권한이 게이트).
- 자체 TLS·리눅스 systemd 유닛 생성·멀티서버 페더레이션·과금 = 비범위(문서/도커로 갈음).
- 회귀 0: 기존 데스크톱 앱·`node dist/src/main.js` 수동 실행·웹 콘솔 전부 불변. CLI/서비스/도커는 순수 추가.

## 4. 태스크 분해(초안 — 플랜에서 확정)

1. `engram-server` CLI 골격(argv 파싱·서브커맨드 디스패치·bin 등록) + `status`·`setup`(파일시스템 직접·기존 스토어 재사용).
2. CLI 관리 명령: `user`·`group`·`config`·`preset` (admin-http 로직/검증 재사용).
3. 윈도우 서비스(node-windows install/uninstall/start/stop) + 방화벽 규칙(netsh) + 비윈도우 안내.
4. 도커(Dockerfile + docker-compose) + `start` 포그라운드 명령.
5. 문서(README 서버 에디션 3방식 + CLI 표) + 실스모크(CLI 명령 실행·서비스 install/uninstall 멱등[윈도우]·도커 빌드 스모크는 가능하면).
