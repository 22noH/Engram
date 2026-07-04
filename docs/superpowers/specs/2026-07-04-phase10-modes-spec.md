# Phase 10 (예정) — 모드 분리 (Chat/Code) + restart-survival

날짜: 2026-07-04
상태: 방향 확정 (구현 대기 — 다음 세션)
맥락: Phase 9 채팅 UI 실사용 중, classify 오분류(코딩을 팀 협업으로) + 코딩 경로 못 찾는 문제 → 모드를 명시적으로 나누기로.

## 확정 결정 (사용자와 대화로)

### 1. 모드 = 상위 개념, 채널 = 그 아래
- **모드 2개: Chat / Code** (Team은 모드 아님 — 아래 참조).
- 화면 상단에 **모드 탭**(클로드 데스크탑 `Chat | Code` 처럼). 모드가 채널보다 상위.
- 각 모드는 **자기 채널 목록만** 보여준다 — Chat 채널과 Code 채널이 **한 목록에 섞이지 않는다**.
  - Chat 탭 → Chat 채널만. Code 탭 → Code 채널만.
- 새 채널은 **현재 보고 있는 탭의 모드**로 생성.
- 데이터상 채널에 `mode: 'chat'|'code'` 필드가 있지만, UI는 모드로 먼저 갈라서 필터링해 보여준다.

### 2. Team은 모드가 아니라 직교하는 능력
- 제가 처음에 Team을 3번째 모드로 뺐던 건 모순(바로 "Team은 어느 모드서든 쓰인다"고 말함). Team은 모드 축이 아니다.
- **Chat 채널**: "이거 팀으로 분석해줘" → 분석 팀(Recon·Infra 등, 위키+웹검색).
- **Code 채널**: 코딩 자체가 이미 팀(분해→배정→코딩 에이전트→게이트→리뷰어).
- 즉 Team = 어느 모드서든 부르는 협업 능력. 모드로 가르지 않는다.

### 3. Code 채널 = 폴더(레포) 바인딩, 첫 진입 시 선택
- 채널 만들 때는 이름+모드만 (가볍게). 폴더 안 물어봄.
- **Code 채널에 처음 들어가면**: 입력창 대신 **"먼저 작업할 폴더를 선택하세요 📁" + [폴더 선택] 버튼** (empty state).
- 버튼 → **OS 폴더 선택창**(Electron `dialog.showOpenDialog({properties:['openDirectory']})`) → 폴더 클릭 → 채널에 `repoPath` 바인딩.
- 바인딩되면 입력창 열리고 채널 헤더에 `📁 <폴더명>` 표시.
- 폴더 안 고르면 코딩 불가 → **텍스트로 경로 치는 일 없음 = 경로 못 찾는 문제 원천 차단**.
- 나중에 채널 ⋯ 메뉴에서 폴더 변경 가능.
- 웹 브라우저(폰)엔 네이티브 폴더창 없으니 텍스트 입력 폴백.

### 4. Code 채널의 라우팅
- Code 채널에서 보낸 메시지는 **classify 건너뛰고** 바인딩된 repoPath로 바로 코딩 흐름(startCoding→pending 컨펌→codeRun).
- → "분석해줘"라고 해도 Code 채널이면 코딩으로 감(오분류 끝).
- 단 벽은 아님 — 필요하면 escape hatch(`team ...`, `ask ...`)로 다른 것도 호출 가능.
- (향후) Code 모드에 "설계(팀 분석) 먼저 → 구현" 연결 흐름 옵션. §13.1 비전(설계→구현 한 흐름).

## 함께 묶을 것 (같은 배치)
- **restart-survival**: 지금 백그라운드 협업/코딩은 메모리(inflight)에만 있어 앱 닫으면 죽음. TaskStore가 상태(PENDING/RUNNING/SUCCESS/FAILED)는 파일로 저장 중 — 빠진 건 **부팅 시 RUNNING 남은 작업 재개**. 사용자 강한 요청("닫으면 중지되면 안 되지").
- 기본 타임아웃은 이미 5분으로 올림(`ec4ec5e`).

## 구현 범위(대략, 착수 시 플랜으로)
- ChatStore 채널에 `mode`, `repoPath` 추가 + setter.
- ws 프로토콜: 채널 생성 시 mode, setRepoPath.
- self.adapter: Code 채널 메시지에 mode/repo 컨텍스트 실어 handleMention에 전달.
- Orchestrator.handleMention: mode='code'면 classify 건너뛰고 startCoding(repoPath, text).
- chat.html: 상단 모드 탭, 모드별 채널 필터, Code 채널 empty state(폴더 선택), 헤더 레포 표시.
- desktop/main.ts: IPC로 폴더 선택 대화상자(dialog.showOpenDialog).
- restart-survival: main.ts 부팅 시 RUNNING 작업 스캔 → 재개(Orchestrator에 재개 진입점).

## 백엔드 잔여 버그/숙제 (세션 중 발견 — 잊지 말 것)
- **[이번 배치] restart-survival** — 위 참조.
- **[이번 배치 or 바로] 상주 EADDRINUSE 크래시** — 포트 47800 점유 시 SelfMessenger의 WebSocketServer 'error' 이벤트가 try/catch 밖에서 터져 상주 전체가 죽음(main.ts의 p.start() try/catch는 promise만 잡고 EventEmitter error는 못 잡음). 좀비/중복 인스턴스일 때 새 상주가 조용히 헤드리스로 밀려나는 게 아니라 크래시. 포트 점유 시 채팅만 비활성하고 상주는 살려야 함(메신저 오류 비활성 관례대로).
- **[관찰됨] 상주 로그 미기록 의심** — 설치앱 상주가 %APPDATA%\engram\logs\engram.log에 안 남기는 정황(진단 중 마지막 줄이 계속 diagnostic pid). PinoLogger 경로/flush 확인 필요.

## 후속(더 뒤)
- 클릭 승인/선택 버튼(구조화 메시지 프로토콜), 원격 이미지 렌더(CSP), 상태/코딩 파이프라인 시각화, Code 모드 "설계(팀)→구현" 연결 흐름.
