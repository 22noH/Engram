# Phase 6b-2 — `@Engram` 멘션 코딩 설계

작성일: 2026-06-28
상태: 설계 확정. 상위 맥락: [[2026-06-28-phase6-tag-design]](Tag 전체) · [[2026-06-28-phase6b-continuity-design]](6b-1 백그라운드).

## 1. 한 줄 정의

메신저에서 자연어로 코딩을 위임한다 — `@Engram api 레포에 로그인 버그 고쳐줘` → Engram이 repo를 경로로 해소(검색)→컨펌받고→백그라운드로 기존 `codeRun` 자율 코딩 루프를 돌려 진행을 중계하고 결과를 보고한다.

## 2. 배경

기존 `engram code <path> "목표"` CLI 흐름(`proposeProject`→사람 승인→`codeRun`, PermissionFence 자동모드+백스톱, 격리 브랜치)을 메신저 진입점에 연결한다. 6b-1의 **post 콜백 + 백그라운드 detach + MentionTracker** 모델을 그대로 재사용한다. `codeRun`·`proposeProject`·`approveProject`·PermissionFence·`detectGate`는 **무변경**.

## 3. 범위

**6b-2만:** 자연어 코딩 위임 → repo 검색·컨펌 → 백그라운드 codeRun → 진행 중계·결과 보고.

**비범위:** 재시작 생존·자가 스케줄(6b-3) · ambient·권한 분리(6c) · 코드 에이전트의 npm install류(샌드박스 후속, 현재 파일편집만) · run-state(pause/resume) 메신저 제어(후속).

## 4. 설계

### 4.1 채택 접근 (사용자 결정)

- **C: 완전 자연어** — 두뇌(classify)가 메시지에서 repo 참조 + 목표를 추출.
- **경로는 검색 후 컨펌** — repo 참조를 실제 경로로 한 번 해소(alias→경로, 또는 searchRoots 검색)한 뒤 해소된 경로를 컨펌 메시지에 박아 승인받고서야 시작. 환각 경로로 바로 안 돌림.
- **확인 답장 게이트** — 완성조건+대상경로 게시 후 `@Engram 승인`을 받아야 codeRun 시작(경로 컨펌 겸함).
- **여러 후보 → 번호 선택 플로우.**

### 4.2 설정 — `runtime/config/coderepos.json`

```json
{
  "aliases": { "api": "C:/repos/api", "engram": "C:/Users/User/Desktop/Src/Engram" },
  "searchRoots": ["C:/repos", "C:/Users/User/Desktop/Src"]
}
```
- 파일 없거나 깨짐 → `{ aliases: {}, searchRoots: [] }`(코딩-바이-멘션 사실상 비활성, 다른 멘션 경로는 정상).
- 신규 로더 `loadCodeRepos(configDir): { aliases: Record<string,string>; searchRoots: string[] }`.
- Orchestrator는 `PathResolver`(옵셔널 주입, 생성자 끝에 추가 — 기존 위치 불변)로 `getConfigDir()`를 얻어 lazy 1회 로드·캐시. PathResolver 미주입(테스트)이면 빈 cfg.

### 4.3 `resolveRepo(repoRef, cfg)` — 경로 해소(검색)

순서:
1. **경로형**(`/`·`\`·드라이브 문자 포함)이고 디렉터리로 존재 → `[그 경로]`.
2. **alias 적중**(cfg.aliases[repoRef], 대소문자 무시) → `[그 경로]`.
3. **검색**: 각 `searchRoot`의 **얕은(depth ≤ 2)** 하위 디렉터리 중 이름이 repoRef와 매칭(대소문자 무시 — 정확 일치 우선, 없으면 부분 포함). 매칭 경로들을 반환.

반환 `string[]`(0/1/N). `// ponytail: 얕은 글로브, 거대 트리 스캔 금지`.

### 4.4 pending 상태 (스레드별 2단 머신)

`Map<threadKey, PendingCode>`:
- `{ kind: 'disambiguate'; candidates: string[]; goal: string }` — 번호 선택 대기.
- `{ kind: 'approve'; projectId: string; path: string }` — 승인 대기.

새 코딩 요청이 오면 기존 pending은 덮어쓴다(스레드당 1건).

### 4.5 `handleMention` 확장 (6b-1 위에)

classify에 `code` 종류 추가 → `{ kind: 'code'; repoRef: string; goal: string }`(chat/collaborate는 그대로). escape hatch `code <repoRef> <goal>`(첫 토큰=repoRef, 나머지=goal)도 둔다.

진입부 처리 순서(상태/escape hatch 검사부에 추가):
- **숫자만**(`/^\d+$/`)이고 pending=disambiguate → 후보 선택: 범위검사 후 `startProposal(candidates[n-1], goal, threadKey, post)`. 범위 밖 → "1~N 중에서 골라주세요".
- **`승인`|`approve`** 이고 pending=approve → `approveProject(projectId)` + `launchCoding(projectId, path, threadKey, post)` + pending 삭제.
- **`취소`|`아니오`|`cancel`** 이고 pending 있음 → pending 삭제 + "취소했어요".
- classify(또는 escape hatch)가 `code` → `startCoding(repoRef, goal, threadKey, post)`.

(이들은 chat/collaborate/상태보다 먼저, 단 정확/접두 매칭이라 일반 대화를 안 가로챔.)

### 4.6 `startCoding` / `startProposal`

```
startCoding(repoRef, goal, threadKey, post):
  matches = resolveRepo(repoRef, cfg)
  0개  → post("'repoRef' 레포를 못 찾았어요. coderepos.json의 alias나 정확한 경로로 불러주세요.")
  1개  → startProposal(matches[0], goal, threadKey, post)
  N개  → pending[threadKey] = {disambiguate, candidates:matches, goal}
         post("여러 개 찾았어요:\n1. …\n2. …\n@Engram <번호>로 골라주세요")

startProposal(path, goal, threadKey, post):
  try fence.assertWritable(path)            // 자기repo·시스템 거부
  catch → post("그 경로엔 쓸 수 없어요(보호 경로)."); return
  cfg = await proposeProject(path, goal)     // 완성조건 초안 + 게이트
  pending[threadKey] = {approve, projectId: cfg.id, path}
  post(`📁 대상: ${path}\n📋 완성조건:\n${번호목록}\n게이트: test=…|build=…|typecheck=…\n맞으면 @Engram 승인 / 취소는 @Engram 취소`)
```

### 4.7 `launchCoding` (백그라운드, 6b-1 모델)

```
launchCoding(projectId, path, threadKey, post): void   // launchCollaboration의 코딩판
  t = tracker.start(threadKey, { question: `코딩: ${path}`, team: ['Coder'] })
  work = (async () => {
    try {
      post('자율 코딩 시작할게요. 진행은 여기 올릴게요.')
      const r = await this.codeRun(projectId, { onProgress: (m) => void post(`· ${m}`) })
      tracker.finish(threadKey, t.id, r.status === 'SUCCESS' ? 'done' : 'failed')
      post(코딩종료메시지(r))   // ✅ SUCCESS(브랜치 …, 사람 머지 대기) / ⚠️ STUCK·STOPPED·BUDGET
    } catch (err) {
      tracker.finish(threadKey, t.id, 'failed')
      logger.warn(…); try { post('코딩 중 문제가 생겼어요 🙏') } catch {}
    }
  })().finally(() => splice inflight)
  inflight.push(work)
```
- `onProgress`만 흘리고 코드 에이전트 날것 사고(onChunk)는 게시 안 함(6a/Phase4 관례).
- 진행 게시가 잦을 수 있어 `· ` 접두 한 줄씩(메신저 rate-limit은 어댑터 책임, 6b-2 비범위 — `// ponytail: 폭주 시 배치는 후속`).

### 4.8 흐름 한 장

```
@Engram api에 로그인 버그 고쳐줘
 → classify code{repoRef:'api', goal:'로그인 버그 고쳐줘'}
 → resolveRepo: [C:/repos/api, C:/old/api]  (2개)
 → post("여러 개…1. …2. … @Engram <번호>")  · pending=disambiguate
@Engram 1
 → startProposal(C:/repos/api) → proposeProject → 완성조건
 → post("📁 대상…📋 완성조건…맞으면 @Engram 승인")  · pending=approve
@Engram 승인
 → approveProject + launchCoding(백그라운드)
 → "· 분해 완료 3작업" "· 게이트 초록: …" … → "✅ SUCCESS (브랜치 engram/proj_…, 머지 대기)"
```

### 4.9 보안

- `resolveRepo`가 경로를 내놓아도 `proposeProject`/`codeRun`은 여전히 `fence.assertWritable` 경유(자기 repo·SYSTEM_DENY 무조건 거부).
- **확인 답장 = 사람 동의**(경로까지 보고 승인). alias 화이트리스트가 흔한 대상을 좁힘.
- 코드는 격리 브랜치(`engram/…`)로만 — 메인 무손상, 사람이 머지.

### 4.10 오류 처리(상주 불사)

- startCoding/startProposal 동기 에러(검색·fence·proposeProject 두뇌콜) → handleMention은 bridge try/catch 안 → 사과. resolveRepo·fence 거부는 자체적으로 안내 post 후 정상 반환.
- launchCoding 백그라운드는 자체 try/catch(6b-1 패턴).
- `승인`/`취소`/숫자 분기는 **pending이 있고 종류가 맞을 때만** 발동. 아니면 그냥 통과해 classify(chat/collaborate/code)로 흘러간다(무해). 즉 pending 없는 `승인`/숫자는 일반 대화로 취급.

### 4.11 테스트

- `coderepos.config.spec`: alias/searchRoots 파싱·missing→빈.
- `resolve-repo.spec`(tmp dir): 경로형 존재·alias·검색 1/N/0·대소문자.
- `orchestrator` 코딩 분기(proposeProject/approveProject/codeRun 스텁 주입): code→1개→propose→pending approve / N개→disambiguate→숫자선택→propose / 승인→approveProject+codeRun 호출(drainForTest) / 취소→clear / 못찾음→안내 / fence 거부→안내.
- 진행 중계: codeRun 스텁의 onProgress 호출→post 캡처.

### 4.12 영향 파일

- 신규: `src/agent-layer/coderepos.ts`(+spec) — `loadCodeRepos(configDir)` + `resolveRepo(repoRef, cfg)` 한 파일(둘 다 작고 관련). 
- 수정: `src/agent-layer/orchestrator.ts`(classify에 code·handleMention 코딩분기·startCoding/startProposal/launchCoding·pending Map·codeRepos 로드) · `prompts/triage.md`(code 종류 설명).
- 무변경: bridge·CoreMessage·codeRun·proposeProject·approveProject·PermissionFence·MentionTracker(재사용).

## 5. 비고

- classify가 code 종류를 안정적으로 내려면 triage.md에 "사용자가 특정 repo에 코드를 쓰거나 고치라고 하면 kind=code, repoRef=레포 참조, goal=할 일"을 명시. alias 목록도 프롬프트에 주입(팀 로스터처럼)해 repoRef 추출 안정화.
- 여러 후보 번호 선택은 본 설계에 포함(사용자 요청).
