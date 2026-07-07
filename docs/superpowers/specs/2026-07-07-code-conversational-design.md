# Code 채널: 대화 기본 + 명시적 코딩 escalate

**날짜:** 2026-07-07
**상태:** 설계 확정(브레인스토밍 완료), 플랜 대기

## 1. 배경 — 문제

Code 채널에서 **무엇을 쳐도 전부 코딩 프로젝트로 꽂힌다.** "왜 막혔어?" 같은 질문조차 완성조건 + 승인/취소 + 게이트 루프로 시작된다.

근본 원인 — [orchestrator.ts:240-248](../../../src/agent-layer/orchestrator.ts):

```js
// Code 채널(Phase 10): classify 건너뛰고 바인딩된 repoPath로 바로 코딩(오분류 차단).
if (msg.mode === 'code') {
  if (!msg.repoPath) { 안내; return; }
  channelGate; await this.startProposal(msg.repoPath, trimmed, threadKey, post);
  return;
}
```

Phase 10은 "Code 채널이면 당연히 코딩"이라 보고 분류를 일부러 건너뛰었다. 그 반작용으로 **질문·조사·논의를 할 방법이 사라졌다.** 매 메시지가 승인 게이트에 걸린다.

## 2. 목표

Code 채널을 **"무조건 코딩" → "레포를 아는 대화, 코딩은 명시적으로 escalate할 때만"** 으로 뒤집는다. Claude Code와 같은 리듬:

> 대화·조사(게이트 0) → 두뇌가 "이건 코드 작업"이라 판단하면 답변에 [구현 시작] 제안 → 누르면 완성조건(=계획) 확인 → 승인 한 번 → 자율 루프.

**기본 경로(그냥 물어봄)는 클릭·승인·게이트가 0이다.** 그게 이 설계의 핵심.

## 3. 동작 설계 (Code 채널)

`handleMention`의 `msg.mode === 'code'` 분기를 강제 `startProposal` → **대화 답변 경로**로 교체한다. escape hatch(team/ask/code/schedule)·pending 처리는 그 앞에 그대로 있으므로 벽이 아니다.

```
Code 채널 메시지 도착
  │
  ├─ repoPath 없음 → "폴더 먼저 선택" 안내(현행 유지)
  │
  └─ 두뇌 1콜: 레포를 읽고(읽기전용) 대화체로 답변
        + 이게 "코드를 고쳐/짜는 요청"이면 답 끝에 propose 마커 첨부
     │
     ├─ 마커 없음 → 답변만 게시. 버튼·게이트 0.  ← 질문/조사/논의의 기본
     │
     └─ 마커 있음 → 답변 게시 + [구현 시작] 버튼 1개(confirm)
           │
           └─ 클릭 → startProposal(repoPath, goal)  ← 기존 그대로
                 → 완성조건 + [승인]/[취소] (Phase 11b 버튼)
                 → 승인 → 자율 루프(codeRun, §5)
```

핵심: **판단이 답변 앞의 별도 분류 콜이 아니라, 답변 안에 녹아 있다(2번 방식).** 한 번 호출로 `{답, 구현제안?}`. one-shot 두뇌에 자연스러운 계약이고, Phase 9에서 데인 "분류+답변 콜 2회 → 수십 초 침묵"을 피한다.

## 4. 구성요소

### 4.1 대화 답변 두뇌 콜 (신규)

- 새 프롬프트 `prompts/code-chat.md`(외부화, 기존 prompts/ 관례).
- 두뇌 호출: `cwd = repoPath`, **읽기전용 도구만**(`--allowedTools Read,Glob,Grep`). Edit/Write 없음 — 답만 하지 파일 안 고침. `PermissionFence`는 쓰기가 아니므로 통과.
- 프롬프트 요지: "이 레포({path})에 대해 대화체로 도와라. 조사하려면 파일을 읽어도 된다. **오직** 사용자가 코드를 고치거나 새로 만들라고 할 때에만**, 답변 뒤에 한 줄 `` ```engram:propose\n{\"goal\":\"<한 줄 목표>\"}\n``` `` 를 붙여라. 질문·설명·논의엔 절대 붙이지 마라."
- 컨텍스트: 최근 대화(`ConversationStore.recent`, 이미 있음) + **이 스레드의 진행 중/최근 코딩 작업 상태**(`tracker.status(threadKey)` + 마지막 게이트 출력). ← 이게 "왜 막혔어?"(= Engram 자기 상태 질문)를 답할 수 있게 한다. 트리거가 됐던 바로 그 예시.

### 4.2 propose 마커 파싱 (edge/orchestrator)

- 두뇌 답에서 `` ```engram:propose ... ``` `` 블록을 **서버 측에서** 추출·제거(`parseJsonBlock` 재사용, 이미 4소비자 공유). 이미 ```chart 블록을 같은 식으로 다룬다.
- 남은 프로즈만 `post(reply, actions?)`로 게시.

### 4.3 [구현 시작] 버튼 = escalate 옵트인

- 마커가 있으면: `this.pending.set(threadKey, { kind: 'proposeReady', repoPath, goal })` + 버튼 `[{ label: '구현 시작', send: '구현 시작' }]`. **confirm 없음** — 이 버튼은 "계획(완성조건) 보여줘"일 뿐 코딩 시작이 아니다. 확인은 다음 단계 승인에만(이미 confirm 있음).
- `handleMention` pending 처리에 `proposeReady` 종류 추가: `trimmed === '구현 시작'` → `startProposal(repoPath, goal, ...)`. 취소는 기존 취소 분기 재사용.
- 이후는 **기존 흐름 무변경**: startProposal이 완성조건 생성 + `kind: 'approve'` 버튼(confirm='자율 코딩을 시작할까요?', Phase 11b) → 승인 → `launchCoding`.

**escalate는 [구현 시작](계획 보여줘) → 승인(계획 확인 후 시작) 두 지점이고, 진짜 확인(confirm)은 승인 한 번뿐.** 그리고 **기본 경로(그냥 물어봄)는 클릭 0**. 사용자가 싫어한 건 "매 메시지 강제 승인"이지 "진짜 코딩 시작할 때 계획 한 번 확인"이 아니다.

## 5. 자율 루프 — 무변경 (이미 있음)

escalate가 착지하는 곳은 **기존 `codeRun`**(Phase 4). 이 스펙은 루프를 안 건드린다. 참고만:

1. 분해 = 계획(완성조건 → 티켓들)
2. 라운드 반복: 티켓 코딩 → **Engram이 직접 게이트 실행**(빌드/테스트/타입체크) → 통과=착지(커밋), 빨강=재시도
3. 리뷰어가 완성조건 검사 → 부족하면 추가 티켓(= 계획 다시 짜기) → 반복
4. 완성조건 충족 + 리뷰어 승인 = 완료. **못 뚫으면(STUCK/예산) 멈추고 보고 + 자가 재개 예약**(6b-3-2).

즉 "승인 후엔 알아서, 계획 다시 짜더라도 결과 나올 때까지 반복(단 무한 삽질 방지)"은 이미 구현돼 있다.

## 6. 범위 밖 / 무변경

- **Ask 채널**은 이미 대화 기본(`route`→ReaderAgent, 위키 기반). 이 스펙은 안 건드린다. Ask에서의 코딩 요청은 기존 classify→startCoding(레포 검색·후보) 그대로.
- **classify()**(chat/collaborate/code/schedule) 자체는 유지. Code 채널만 그 앞에서 대화 경로로 새게 한다.
- escape hatch(`team`/`ask`/`code`/`schedule`/`resume`/`retry`), pending, 상태 조회 — 전부 무변경.

## 7. 향후 (별도 스펙, 지금 아님)

- **지식 코어 MCP 서버** — 위키+RAG를 MCP로 노출해 다른 Claude Code 세션/클라이언트가 Engram의 축적된 기억을 읽게 한다. 기존 코어 메서드(`RagStore.search`·`WikiEngine` 읽기·`ProposalStore` 쓰기 결재)에 얇은 창구만 붙이는 덧셈. **자율 상주 Engram은 안 건드림** — 옆에 "기억을 여는 문" 하나 추가. 로드맵 후반 공유 위키와 연결. (아이디어 단계, 브레인스토밍 후 착수.)
  - 주의: Engram 전체를 MCP 플러그인으로 만드는 건 불가 — MCP 도구는 수동(클라이언트가 부를 때만)이라 Engram의 자율·상주·@멘션·두뇌교체·다중사용자가 죽는다. MCP로 여는 건 **지식 코어(읽기+결재쓰기)만**.

## 8. 테스트 관점

- Code 채널 질문 → 대화 답변만, propose 없음, 버튼 0 (오분류 회귀 방지).
- Code 채널 코드요청 → 답변 + [구현 시작] 버튼 1개, pending=proposeReady.
- [구현 시작] → startProposal 경유(완성조건+승인 버튼)로 이어짐.
- propose 마커 파싱: 마커 제거 후 프로즈만 남는지, goal 추출 정확한지.
- 대화 답변이 읽기전용 도구만 받는지(쓰기 도구 없음).
- "왜 막혔어?"류: 스레드에 STUCK 작업 있을 때 그 상태가 컨텍스트로 들어가는지.
