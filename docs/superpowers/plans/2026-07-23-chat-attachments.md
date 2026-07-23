# 채팅 첨부 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 이미지 붙여넣기·파일 첨부를 채팅에 추가하고 두뇌가 보고 이해하게(vision+텍스트 읽기), 보존은 메시지와 운명 공유.

**Architecture:** 실파일=AttachmentStore(dataDir/attachments/<ch>/<id>), 전송=기존 self.adapter HTTP 체인에 AttachmentsHttp 추가(AuthHttp handle 관례), 메시지=additive `attachments` 필드, 두뇌=MentionEvent→CoreMessage→buildPrompt/CompleteOpts additive 관통. 렌더러는 웹 표준(input file·ClipboardEvent·drop)만 — 데스크톱 브리지 불필요.

**Spec:** `docs/superpowers/specs/2026-07-23-chat-attachments-design.md` — 상한·타입·게이트·운명공유 규칙 verbatim.

## Global Constraints

- 회귀 0: attachments 없는 메시지의 저장·전송·렌더·두뇌 경로 byte-identical. 기존 HTTP 라우트 무변경.
- 게이트 재사용: HTTP는 bearer→sessions.resolve→account, 무인증은 기존 localFree 루프백 규칙(auth-http.ts:99 관례) — 새 우회 금지. 채널 접근은 계정 기준 재검사(비공개 채널 memberIds/creatorId — ws canAccessChannel과 동일 규칙, 로직 추출/재사용·중복 금지).
- 경로 안전: 파일 경로에 서버 발급 uuid만(사용자 파일명은 메타). safeId(channelId) 검증. 응답에 내부 경로 미노출.
- 삭제는 never-throw(로그만). ⚠️ chat-store appendMessage input 스프레드 allow-list에 `attachments` 등재.
- 상한(스펙): 파일 20MB·메시지당 5개·텍스트 삽입 256KB. 이미지 화이트리스트 png/jpg/gif/webp.
- 커밋 Co-Authored-By 금지·무관 더티 파일 스테이징 금지·jest 포그라운드.

---

### Task 1: AttachmentStore + 프로토콜 + 운명 공유

**Files:**
- Create: `src/edge/messenger/attachment-store.ts`(+spec)
- Modify: `shared/protocol.ts`(Message.attachments+send 프레임), `src/edge/messenger/chat-store.ts`(allow-list+삭제 훅 3곳)

**Interfaces (Produces):**
```ts
// shared/protocol.ts
export interface AttachmentMeta { id: string; name: string; mime: string; size: number }
// Message에: attachments?: AttachmentMeta[]
// send 프레임에: attachments?: string[]  (업로드된 id 목록)
// attachment-store.ts — 전부 동기 fs, never-throw 삭제
export class AttachmentStore {
  constructor(dataDir: string) {}
  save(channelId: string, name: string, mime: string, data: Buffer): AttachmentMeta | null; // 상한·safeId 검증, id=randomUUID(+확장자 보존)
  path(channelId: string, id: string): string | null;   // 실재하는 uuid만, 아니면 null
  meta(channelId: string, id: string): AttachmentMeta | null; // 사이드카 <id>.json 메타
  deleteFor(messages: ChatMessage[]): void;              // 메시지들의 attachments 실파일+메타 삭제(never-throw)
}
```
- chat-store 운명 공유(탐색 확정 지점): ①`removeMessagesByIds`가 제거된 ChatMessage[]를 수집해 반환(additive 반환값 — 기존 호출부 무영향)하고 호출부/스토어가 `attachmentStore.deleteFor(removed)` ②`pruneChannel` no-hook 브랜치(line ~340)에 dropped 객체 계산 추가(autoCompact 브랜치는 이미 dropped 있음 — 거기도 훅) ③`dropClearBackup`이 unlink 전 백업 jsonl 파싱→deleteFor. clearChannel/undoClear는 무변경(백업 생존 규칙). AttachmentStore 주입은 ChatStore 옵션(미주입=무동작=회귀 0).

- [ ] Step 1: TDD — save 왕복(메타·실파일)·상한 거부·path 위조 id null·deleteFor 삭제·removeMessagesByIds 반환값·prune/dropBackup 시 실파일 삭제 실증(임시 디렉터리). RED→GREEN.
- [ ] Step 2: full test·build. `git commit -m "feat(attach): AttachmentStore+프로토콜+운명공유(프루닝·정리·clear확정 시 실파일 삭제)"`

---

### Task 2: AttachmentsHttp (업로드/다운로드)

**Files:**
- Create: `src/edge/auth/attachments-http.ts`(+spec — auth 디렉터리 관례 무방하면 edge/messenger 옆도 가 — 구현자가 형제 파일 관례 보고 결정·보고)
- Modify: `src/edge/messenger/self.adapter.ts`(라우트 체인 1블록+deps), `src/main.ts`(배선 — authDeps/adminDeps 관례)

**Interfaces:**
- `POST /attachments/<channelId>` raw body(Content-Type=mime, `x-attachment-name` 헤더=인코딩된 파일명) → `{id,name,mime,size}` | 4xx. 크기 상한 스트리밍 검사(64KB readBody 관례 아님 — 20MB라 자체 누적+상한 컷, oversize 시 settle 가드 — auth-http readBody의 T4 hang 픽스 교훈 참조).
- `GET /attachments/<channelId>/<id>` → 파일 스트림(mime 화이트리스트 밖=octet-stream·Content-Disposition) | 404.
- 게이트: 세션 bearer resolve(+무인증 localFree 루프백) + 계정 기준 채널 접근 재검사(ws canAccessChannel 규칙 추출 재사용). AuthHttp.handle(req,res):Promise<boolean> 관례.

- [ ] Step 1: TDD — 실 http 왕복(업로드→다운로드 바이트 동일)·무세션 401·비접근 채널 403/404·상한 초과 4xx(hang 없음)·위조 id 404. RED→GREEN.
- [ ] Step 2: full test·build. `git commit -m "feat(attach): 업로드/다운로드 HTTP(세션 게이트·채널 접근 재검사·상한)"`

---

### Task 3: 메시지 스탬프 + 두뇌 관통

**Files:**
- Modify: `src/edge/messenger/self.adapter.ts`(onSend attachments ids 검증·스탬프+MentionEvent), `src/edge/messenger/messenger.port.ts`(MentionEvent.attachments), `src/edge/messenger/messenger-bridge.ts`, `src/edge/core-message.ts`, `src/agent-layer/reader-agent.ts`(buildPrompt Attachments 블록+CompleteOpts.images), `src/brain/brain.port.ts`(CompleteOpts.images?: {mime,dataBase64}[]), `src/brain/anthropic-api.brain.ts`(초기 user content 블록화), `src/brain/openai-api.brain.ts`(content 타입 확장+image_url), `src/brain/claude-cli.brain.ts` 경유 경로(프롬프트에 절대경로 — reader-agent에서 CLI 하네스 구분 없이 경로 텍스트 포함이면 충분한지 실코드 판단·보고)

**Interfaces:**
- onSend: `f.attachments`가 string[]이면 실재 id만(AttachmentStore.meta) 메시지에 `attachments: AttachmentMeta[]` 스탬프(위조 무시). MentionEvent에 `attachments?: Array<AttachmentMeta & { path: string }>`.
- reader-agent: 이미지(화이트리스트 mime)→CompleteOpts.images(base64)+프롬프트에 `[Image attached: name]`, 텍스트계(확장자 화이트리스트·256KB)→프롬프트 `# Attachments` 블록에 내용 삽입(초과분 절단 표시), 기타→`[Attachment: name (mime, size)]`. 경로 텍스트는 항상 포함(CLI가 직접 읽는 경로).
- anthropic: images 있으면 초기 content=[{text},{image source base64}…]. openai: content 타입 확장+image_url(data URL) — 미지원 모델 에러는 기존 에러 경로(폴백 시도 없음·보고).

- [ ] Step 1: TDD — onSend 스탬프(위조 무시)·bridge 관통·buildPrompt 블록(이미지 표시/텍스트 삽입/절단/기타 폴백)·anthropic 요청 body 이미지 블록(SSE 스텁)·openai 동일. RED→GREEN.
- [ ] Step 2: full test·build. `git commit -m "feat(attach): 두뇌 관통(vision 이미지 블록·텍스트 삽입·CLI 경로·폴백)"`

---

### Task 4: 렌더러 (입력·칩·렌더)

**Files:**
- Modify: `renderer/src/App.tsx`(#inputbar 클립 버튼·onPaste·onDrop·pending 칩 상태·업로드→sendText attachments), `renderer/src/auth-api.ts`(업로드/다운로드 fetch 헬퍼 — httpBase 재사용), `renderer/src/components/Message.tsx`(썸네일·파일 칩), `renderer/src/i18n.ts`, `renderer/src/theme.css`(.attachChip·.msgImg — QL 토큰)
- Test: 관련 컴포넌트 테스트

**Interfaces:**
- 입력: 클립 버튼=`<input type="file" multiple hidden>` 트리거·onPaste=`e.clipboardData.files`·onDrop. 추가 즉시 업로드(진행 중 칩 스피너·실패 칩 danger 표시·X=제거), 성공 시 id 보유. Send 시 `sendText(text, threadId?, answersId?, attachmentIds?)` — 텍스트 비어도 첨부만 전송 허용(칩 있으면 Send 활성).
- 표시: `m.attachments` 이미지 mime=썸네일 `<img src=GET url>`(클릭=새 창/원본)·기타=칩(클릭=GET url 다운로드). 세션 토큰 필요한 연결은 fetch+blob URL(Authorization 헤더 — img 태그 직접 로드 불가한 인증 연결 대응, 무인증 로컬은 직접 src. 구현자가 두 경로 중 단일화 가능하면 blob 통일·보고).
- 목업 A 픽셀: 전송 전 칩 줄(입력창 위)·버블 내 썸네일 radius 7px·파일 칩 아이콘+이름+타입·크기.

- [ ] Step 1: TDD(vitest) — 붙여넣기→칩 표시·업로드 fetch 호출·X 제거·Send 프레임 attachments ids·메시지 썸네일/칩 렌더·첨부만 전송. RED→GREEN.
- [ ] Step 2: 렌더러 full·tsc·build+백엔드 회귀. `git commit -m "feat(attach): 렌더러 첨부(클립·붙여넣기·드롭·칩·썸네일) — 목업 픽셀"`

---

### Task 5: 실스모크

- Create: `scripts/smoke-attachments.ts` — 실서버+mock 두뇌: ①HTTP 업로드(이미지+텍스트 파일)→②send attachments→메시지 스탬프 브로드캐스트 확인→③mock 두뇌 수신 프롬프트에 텍스트 내용 삽입+이미지 base64 전달 확인→④다운로드 바이트 동일→⑤위조 id 무시→⑥retention count 프루닝 시 실파일 삭제 실증→⑦/clear→dropBackup 시 삭제·undo 경로 보존. 2회 연속 PASS.
- [ ] full 전체+build 후 `git commit -m "test(attach): 실스모크(업로드→두뇌 관통→운명공유 삭제 실증)"`

## Self-Review 결과

- 스펙 커버: 저장·운명공유(T1)·HTTP 게이트(T2)·두뇌 3하네스+폴백(T3)·UI 목업(T4)·실증(T5). 비목표(위키 첨부·RAG 색인) 제외.
- 함정 명시: allow-list·readBody hang 교훈·경로 uuid만·비공개 채널 계정 재검사 로직 재사용(중복 금지)·인증 연결 img 로드(blob 경로).
- 불확실(구현 중 확정·보고): AttachmentsHttp 파일 위치·CLI 경로 전달 충분성·openai vision 미지원 모델 거동·blob/직접 src 단일화.
