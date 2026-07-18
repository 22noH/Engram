# 헤드리스 엔그램 MCP — 설계

날짜: 2026-07-18
상태: 승인됨 (브레인스토밍 완료)

## 1. 목적

Electron 앱 없이 `npx engram-mcp` 한 줄로 엔그램 지식 코어(마크다운 위키+의미검색+
제안 대기열)를 stdio MCP 서버로 쓰게 한다. Basic Memory류 "MCP 서버가 곧 제품" 배포
모델 — 설치 장벽 없이 Claude Code 사용자를 엔그램 위키로 끌어들이는 깔때기. 데이터가
앱과 같은 위치라 나중에 앱을 깔면 위키·제안이 그대로 이어진다.

## 2. 사용자 결정

- 승인 게이트: **기본=승인 도구 노출**(list_proposals·approve_proposal·reject_proposal
  — 승인함이 채팅으로 들어옴, 앱과 같은 원칙·같은 대기열) + **옵션 `--write-mode`**
  (wiki_write 직접 쓰기 — Basic Memory식 무마찰, 되돌림은 git 이력).
- 배포: **패키징까지만**(bin+files+`npm pack` 타볼 npx 실검증). publish(계정·이름)는
  사용자 몫으로 남김.
- 데이터 위치: **앱과 동일**(%APPDATA%/Engram 상당) 기본, `--data-dir` 오버라이드.
- ★추가 결정: **앱 /mcp에도 동일 기능을 모드로 지원** — 승인 도구 3종은 앱에서도
  노출(승인함 UI와 병행), 직접쓰기는 앱 설정 토글(기본=제안만). 헤드리스와 앱이
  같은 도구 셋·같은 원칙.

## 3. 설계

### 3.1 엔트리 (신규 src/mcp-headless.ts → bin `engram-mcp`)

- 인자: `--data-dir <path>`(기본=앱 userData 경로 — Electron 없이 같은 위치를 계산:
  win=%APPDATA%/Engram·mac=~/Library/Application Support/Engram·linux=~/.config/Engram),
  `--write-mode`, `--port <n>`(공존 감지·브리지용, 기본 DEFAULT_CHAT_PORT).
- 부트: `ENGRAM_DATA_DIR`를 스스로 설정(미설정 시) → Nest
  `createApplicationContext(AppModule)`로 지식 코어 가동 — 채팅(SelfMessenger)·계정·
  Discord·스케줄·위키원격동기화는 **엮지 않는다**(main.ts의 edge 배선을 안 하는 것 —
  AppModule 자체는 재사용, 스케줄러 @Cron이 있으면 헤드리스에 유해한지 확인 후 필요시
  비활성 플래그). stdout은 MCP 와이어 전용 — 모든 로그는 stderr(PinoLogger 파일로그 유지).
- 도구 주입: 8c-2 `buildMcpServer(deps)` 재사용 — askBrain=null(헤드리스에 두뇌 없음),
  §3.3 확장 deps 주입.
- StdioServerTransport로 서빙. SIGINT/stdin EOF에 Nest 컨텍스트 close(임베딩·DB 정리).

### 3.2 앱과의 공존 — 충돌 방지 (핵심 설계)

- 시작 시 `http://127.0.0.1:<port>/` 헬스 프로브(짧은 타임아웃).
  - **상주가 떠 있으면**: LanceDB 동시 접근 위험 → 코어를 직접 열지 않고 **기존
    mcp-bridge의 makeBridgeServer(url)로 자동 전환**(stderr에 한 줄 안내). 사용자는
    `npx engram-mcp` 하나로 앱 유무와 무관하게 항상 동작, 데이터는 항상 한 곳.
    (§3.4로 앱 /mcp도 승인 도구를 갖추므로 브리지 모드에서도 도구 셋 동일.
    wiki_write만 앱 설정 토글에 따름 — 헤드리스 --write-mode와 무관하게 앱 모드 우선,
    stderr 안내에 명시.)
  - 안 떠 있으면: §3.1 헤드리스 코어 부트.
- 역방향(헤드리스 실행 중 앱 시작)의 동시 접근은 비범위 — 앱 시작 시 헤드리스가
  이미 DB를 열고 있는 짧은 겹침은 LanceDB 파일락 특성상 낮은 위험으로 수용하고
  README에 "앱을 켤 땐 헤드리스 세션 종료 권장" 한 줄. // ponytail: 상호 락 파일은 후속

### 3.3 승인·직접쓰기 도구 (buildMcpServer 확장 — 8c-2 코어 수정)

- `McpDeps` 옵션 확장(기존 필드·기존 노출 무변경 = 8c-2 회귀 0):

```typescript
proposals?: {
  list(): Promise<Array<{ id: string; title: string; op: string; targetSlug: string; preview: string }>>;
  approve(id: string): Promise<string>;  // 결과 요약 텍스트(적용된 slug 등)
  reject(id: string): Promise<string>;
} | null;
write?: ((input: { slug?: string; title: string; content: string }) => Promise<string>) | null;
```

- `proposals` 주입 시 도구 3종 노출: `list_proposals`(pending만, preview는 payload 앞
  200자)·`approve_proposal {id}`·`reject_proposal {id}`. 미존재/이미 처리된 id →
  isError. 도구 설명에 "approval is the human gate — only call when the user explicitly
  asks" 명시(모델 자가승인 억제, 클라이언트 권한 프롬프트가 이중 안전).
- `write` 주입 시(`--write-mode`) `wiki_write` 노출: 기존 slug면 editPage(게시본)·
  없으면 createPage+publish 상당 — WikiEngine 기존 메서드만 조합(코어 무변경 원칙,
  조합이 안 되면 헤드리스 어댑터에서 create→approve 경로 재사용).
- **승인 어댑터는 공용 모듈**(신규 src/edge/mcp/mcp-proposals.ts 상당):
  ProposalStore+ProposalApplier로 list/approve/reject 구현 + in-flight Set +
  status 재확인(pending 아닌 id는 isError — 이중승인 차단). 헤드리스와 앱 main이
  **같은 모듈을 주입**.
  ★앱에서의 교차 경로 동시성: 승인함 UI(ws)와 MCP가 같은 제안을 동시에 승인하는
  경우 — MCP 어댑터의 status 재확인이 1차 방어. ws 경로와 in-flight Set 인스턴스를
  공유할 수 있으면 공유(플랜에서 self.adapter 구조 확인 후 결정), 불가하면 짧은
  TOCTOU 창을 문서화 수용(적용은 멱등에 가깝고 스케줄 경합 수용 전례와 동급).

### 3.4 앱 /mcp 모드 지원 (main.ts + 설정창)

- main.ts의 기존 mcpDeps에 §3.3 공용 승인 어댑터를 주입 — 앱 /mcp에도 승인 도구
  3종 노출(승인함 UI와 병행 — 채팅으로도 승인 가능해짐). 브리지 모드 헤드리스도
  자동으로 같은 도구를 얻음(§3.2의 도구 축소 주의가 해소됨).
- 직접쓰기 모드: permissions.json `allow.mcpWriteMode: 'propose' | 'write'`(기본
  'propose'). 'write'면 앱 /mcp에도 wiki_write 노출. 설정창 MCP 섹션에 토글 한 줄
  (인셋 문법·재시작 힌트·기존 permissions-file 패턴 확장).
- 헤드리스 `--write-mode`와 앱 토글은 같은 도구를 켜는 두 표면 — 도구 구현은
  buildMcpServer 한 곳.

### 3.5 패키징 (publish 준비 완료 상태)

- package.json: `bin: { "engram-mcp": "dist/src/mcp-headless.js" }`(shebang 필요),
  `files`: dist·prompts·README 위주로 슬림화(renderer/dist·src·docs 제외 — 단,
  상주 main.js가 필요로 하는 리소스 경로 확인). 네이티브·모델: @lancedb는 npm 설치로
  해결, bge-m3는 첫 wiki_search 때 자동 다운로드(도구 설명에 첫 호출 지연 명시).
- 검증: `npm pack` → 타볼을 임시 폴더에서 `npx <tarball>`로 실행해 실왕복.
- 이름(engram-mcp 등)·publish는 사용자 결정 대기.

### 3.6 보안 모델

- stdio = 클라이언트가 직접 spawn(네트워크 노출 없음). 승인 도구는 사람 지시 전제
  (도구 설명+클라이언트 권한 프롬프트 이중장치). write-mode는 명시적 opt-in 플래그.
- 데이터는 전부 로컬 파일(마크다운+LanceDB) — 사용자 소유, git 이력이 되돌림.

## 4. 테스트

- buildMcpServer 확장: proposals/write 주입 유무별 tools/list, 승인·거부·중복처리·
  write 신규/기존 분기 — InMemory 실프로토콜(기존 패턴).
- 헤드리스 조립부(엔트리에서 분리한 순수 함수): 인자 파싱(data-dir 기본 OS별 경로),
  상주 감지 분기(헬스 200→브리지 서버 반환·연결거부→코어 부트 선택) — 실 http로.
- 어댑터: in-flight 이중승인 가드.
- 실스모크(controller): 앱 종료 → `npx <타볼>`을 Claude Code에 등록(stdio) →
  propose→list→approve 왕복·위키 파일 생성 확인 → 앱 실행 → 재시작한 헤드리스가
  브리지 모드로 폴백하는 것 확인.

## 5. 비범위

- npm publish(계정·이름 — 사용자)·상호 프로세스 락파일·원격 접속·헤드리스에서
  두뇌(ask_brain)·위키 원격 동기화(15b — 앱 전용 유지).
