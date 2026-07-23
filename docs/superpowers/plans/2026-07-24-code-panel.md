# 코드 패널 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 코드 채널 우측 분할 패널 — 진짜 터미널(OS 기본 셸)·미리보기(iframe)·git diff 뷰어. 데스크톱 전용.

**Architecture:** pty는 메인 프로세스(node-pty)+IPC 스트리밍(webContents.send — 레포 첫 스트리밍 채널), 렌더러는 xterm.js. diff는 simple-git(기존 dep) 재사용을 메인 프로세스 모듈로. 프리뷰는 샌드박스 iframe(webviewTag 불필요 — 탐색 확정). 전부 contextBridge 경유(contextIsolation 유지).

**Spec:** `docs/superpowers/specs/2026-07-23-code-panel-design.md` — 범위(코드 채널만·데스크톱만)·테마 추종 터미널·세션 규칙 verbatim.

## Global Constraints

- 회귀 0: 패널 미사용/비데스크톱/비코드 채널에서 기존 화면·동작 byte-identical. `.chatCol` 중앙 칼럼은 패널 열림 시 남는 폭 안에서 유지.
- 렌더러에 노드 API 미노출(contextIsolation 유지) — pty·git·다이얼로그 전부 preload contextBridge 경유. Preview iframe은 sandbox 속성 명시.
- 터미널: OS 기본 셸(win32=`powershell.exe`, darwin=`zsh`, 그 외=`$SHELL`||`bash`)·cwd=채널 repoPath·채널당 1세션(패널 닫기=숨김·세션 유지)·채널 삭제/앱 종료(before-quit) 시 kill — 고아 프로세스 0. 테마 추종(검정 고정 금지 — xterm 테마를 QL 토큰 값으로 라이트/다크 연동).
- diff는 읽기 전용(simple-git raw — 쓰기 조작 금지)·레포 아님/git 없음=안내 결과형(throw 금지).
- ⚠️ node-pty=네이티브 모듈: electron-builder 기본 npmRebuild가 패키징은 커버하나 `desktop:dev`(electron .)는 ABI 리빌드 필요 — T1이 실검증(스파이크 우선, 실패 시 대안 보고 후 중단).
- UI 영어 기본+ko·QL 토큰만·커밋 Co-Authored-By 금지·무관 파일 스테이징 금지·jest 포그라운드.

---

### Task 1: pty 인프라(메인 프로세스+IPC 스트리밍) — 스파이크 포함

**Files:**
- Create: `src/desktop/pty-manager.ts`(+spec — spawn 주입식 유닛테스트), Modify: `package.json`(node-pty dep+필요시 rebuild 스크립트), `src/desktop/main.ts`(ipc 등록+before-quit 정리), `src/desktop/chat-preload.ts`, `renderer/src/desktop.d.ts`

**Interfaces (Produces):**
```ts
// pty-manager.ts — electron 비의존 순수 로직(spawn 팩토리 주입)
export class PtyManager {
  start(channelId: string, cwd: string): { sid: string; shell: string } | { error: string }; // 채널당 1세션(기존 있으면 재사용 반환)
  write(sid: string, data: string): void;
  resize(sid: string, cols: number, rows: number): void;
  kill(sid: string): void;          // never-throw
  killAll(): void;                  // before-quit
  onData(cb: (sid: string, data: string) => void): void;
  onExit(cb: (sid: string, code: number) => void): void;
}
// preload 노출(engramDesktop 확장):
ptyStart(channelId, cwd) / ptyWrite(sid, data) / ptyResize(sid, c, r) / ptyKill(sid)  // invoke
onPtyData(cb) / onPtyExit(cb) → 해제 함수 반환  // ipcRenderer.on — 레포 첫 스트리밍 채널(webContents.send)
```
- 셸 선택 규칙은 Global Constraints verbatim. main.ts: `ipcMain.handle('engram:pty-*')` 관례 + `chatWin.webContents.send('engram:pty-data', {sid, data})`.

- [ ] **Step 0 스파이크(선행)**: `npm i node-pty` 후 `desktop:dev`(electron .)에서 실 PowerShell 스폰·에코 왕복 확인. ABI 불일치 시 `@electron/rebuild` 도입해 재검증. 실패 시 BLOCKED 보고(대안: child_process+ConPTY 폴백 검토는 컨트롤러 결정) — 이 스파이크가 성공해야 나머지 진행.
- [ ] Step 1: TDD(주입 spawn) — 채널당 1세션·write/resize/kill 위임·killAll·onData 배선·never-throw. GREEN 후 main/preload 글루(얇게, 테스트는 모듈 위주).
- [ ] Step 2: full test·build·`desktop:dev` 실스폰 재확인. `git commit -m "feat(code-panel): pty 인프라(node-pty+IPC 스트리밍·채널당 1세션·종료 정리)"`

---

### Task 2: git diff IPC

**Files:**
- Create: `src/desktop/git-diff.ts`(+spec — 실 임시 git 레포로 테스트), Modify: `src/desktop/main.ts`(handle 2개), `chat-preload.ts`, `desktop.d.ts`

**Interfaces:**
```ts
// git-diff.ts — simple-git 재사용(wiki-git 관례: try/catch·상태 결과형·throw 금지)
export async function diffStatus(repoPath: string): Promise<{ ok: true; files: Array<{ path: string; status: 'A'|'M'|'D'|'R'|'?' }> } | { ok: false; reason: 'not-repo'|'git-missing'|'error' }>;
export async function diffFile(repoPath: string, file: string): Promise<{ ok: true; diff: string } | { ok: false; reason: string }>;  // file은 diffStatus 반환 목록의 값만 신뢰(임의 경로 그대로 git에 넘기지 않게 -- 구분자 사용)
```
- preload: `gitDiffStatus(repoPath)` / `gitDiffFile(repoPath, file)`.

- [ ] Step 1: TDD — 임시 실레포(init·수정·신규·삭제 파일)로 status 목록·파일 diff·not-repo·`--` 구분자로 옵션 주입 차단. GREEN.
- [ ] Step 2: full test·build. `git commit -m "feat(code-panel): git diff IPC(simple-git 재사용·읽기 전용·결과형)"`

---

### Task 3: 렌더러 CodePanel(터미널·프리뷰·Diff — 목업 픽셀)

**Files:**
- Create: `renderer/src/components/CodePanel.tsx`(+test), Modify: `renderer/package.json`(`@xterm/xterm`+`@xterm/addon-fit`), `renderer/src/App.tsx`(#chhdr 우측 아이콘 3개+#main row 전환+패널 마운트), `renderer/src/theme.css`, `renderer/src/i18n.ts`

**Interfaces:**
- 게이트: `mode==='code' && defaultChan?.repoPath && window.engramDesktop?.ptyStart`(비데스크톱=아이콘 미노출). 아이콘 3개(터미널·프리뷰·Diff — 목업 B 형태), 클릭=패널 열기+해당 탭.
- 패널: `#main`을 code+패널 열림일 때만 row 배치(`.chatCol`+`.codePanel`), 폭 드래그 스플리터(마우스 이벤트 — 레포 첫 스플리터, localStorage `engram.codePanel.width` 퍼시스트), 열림 상태 채널별 기억(localStorage 맵).
- Terminal 탭: xterm+fit addon. 테마=QL 토큰 값(getComputedStyle로 --bg/--text/--accent 읽어 xterm theme 구성+prefers-color-scheme 변경 리스너). ptyStart(channelId, repoPath)→onPtyData 구독(해제 함수 정리)·입력→ptyWrite·리사이즈→fit+ptyResize. 탭 라벨=start가 돌려준 shell 이름. 패널 닫기=언마운트여도 세션 유지(재열기 시 같은 sid 재구독 — PtyManager가 버퍼 최근 N줄 리플레이 제공: T1 인터페이스에 `replay(sid): string` 추가).
- Preview 탭: URL 입력(기본 placeholder `http://localhost:5173`)+iframe(`sandbox="allow-scripts allow-same-origin allow-forms"`)+새로고침(키 리마운트)+외부 열기(a target 새 창 — 데스크톱은 shell.openExternal 경유 preload 추가 여부 구현자 판단·보고).
- Diff 탭: 열 때 gitDiffStatus 갱신(배지=파일 수)·파일 클릭→gitDiffFile unified 렌더(추가행/삭제행 QL 파생색·모노스페이스·읽기 전용 pre). not-repo/에러=안내 문구.
- 테스트: jsdom에서 xterm 실렌더는 무리 — pty/IPC 경계 모킹으로 배선(구독/해제/write 호출) 검증+아이콘 게이트+Diff 목록/뷰 렌더+스플리터 상태 퍼시스트. xterm 실동작은 T4 실측.

- [ ] Step 1: TDD 배선+구현(위 규칙). 렌더러 full green·tsc·build.
- [ ] Step 2: `git commit -m "feat(code-panel): 우측 패널(터미널 xterm·프리뷰 iframe·diff 뷰어)+아이콘·스플리터 — 목업 픽셀"`

---

### Task 4: 실측 검증 패스

- [ ] 실 Electron(`desktop:dev`)에서: 코드 채널 열고 ①터미널 실 PowerShell 프롬프트·명령 에코·리사이즈 ②패널 닫고 재열기=세션 유지(리플레이) ③프리뷰에 로컬 서버 URL 로드 ④diff에 실변경 표시 ⑤라이트/다크 테마 추종 ⑥앱 종료 후 셸 프로세스 잔존 0 확인. 스크린샷 저장(.superpowers/sdd/code-panel-shots/). CSS/동작 버그 즉시 픽스.
- [ ] 전체 테스트·빌드 재확인 후 픽스 커밋(발견 0이면 기록만).

## Self-Review 결과

- 스펙 커버: 터미널(T1+T3)·프리뷰(T3)·diff(T2+T3)·범위 게이트·테마 추종·세션 규칙·정리(T1 killAll)·실측(T4). 비목표(원격 노출·멀티탭·diff 쓰기) 제외.
- 리스크 선행: node-pty ABI 스파이크가 T1 Step 0(실패=조기 BLOCKED, 이후 태스크 낭비 없음).
- 신규 패턴 명시: 스트리밍 IPC(webContents.send)·스플리터 — 레포 첫 도입임을 태스크에 적시.
- 불확실(구현 중 확정·보고): shell.openExternal preload 추가 여부·xterm 테마 토큰 추출 방식·리플레이 버퍼 크기.
