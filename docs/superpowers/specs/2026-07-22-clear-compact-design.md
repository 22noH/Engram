# 앱 채팅 /clear · /compact + 자동 compact 설계

**날짜:** 2026-07-22 · **목업(픽셀 계약):** `docs/superpowers/mockups/2026-07-21-clear-compact.html`

## 목표

앱 채팅에 대화 정리 두 명령을 넣는다. Engram의 "상태 보존 위키" 철학대로, 지우기 전에 지식을 위키로 흘려보낸다.

- **`/clear`** — 이 채널 대화 기록을 즉시 삭제(컨텍스트+화면 리셋). 확인창·시스템 메시지 없음. 단 몇 초짜리 "실행취소" 토스트로 되돌릴 수 있음.
- **`/compact`** — 채널 AI가 대화를 요약 → 요약을 채팅 메시지로 한 번 보여주고 → 위키에 바로 저장 → 기록 정리. 요약 메시지가 앵커로 남아 RAG가 읽어 이어감.
- **자동 compact** — 보존 정책(S4)이 오래된 대화를 프루닝하기 직전 자동 요약 → 위키에 바로 게시(+`auto-compact` 태그) → 프루닝. 기본 켜짐.

## 핵심 배경 (왜 이런 모양인가)

Engram의 AI 컨텍스트는 "차오르는 창"이 아니다. 답할 때 보는 것은 `conversations.recent(userId, 6)`(최근 6턴, 답변 400자 컷) + 위키 RAG뿐(`src/agent-layer/orchestrator.ts:421`). 그래서 클로드코드식 "컨텍스트 N% 참" 게이지가 개념적으로 없다 — 오래된 건 계속 자동으로 잊히고, 장기 기억은 위키가 담당한다. 따라서 auto-compact의 트리거는 "창이 참"이 아니라 **"보존 정책이 오래된 대화를 잊기(프루닝) 직전"**이다.

continuity(이어감) 원리 = RAG는 **게시된** 위키만 읽는다. 그래서 compact 요약은 승인 대기열이 아니라 **바로 게시**해야 이어짐이 안 끊긴다(자동/수동 공통). 사용자가 명령/토글을 켠 것 자체가 동의(채팅 동의=사람 승인).

## 안전선 (불변)

- **위키/RAG 지식은 절대 삭제하지 않는다.** /clear·/compact·auto-compact 모두 채널 대화 jsonl만 건드린다. S4 안전선 그대로.
- **/clear는 되돌릴 수 있다** — 삭제는 파일을 백업으로 rename(원자적), 토스트 창(~6초) 동안 복원 가능. 창이 끝나거나 다음 clear면 백업 완전 삭제.
- 기존 회귀 0: 보존 무제한(기본)이면 프루닝 없음 → auto-compact도 없음.

## 아키텍처

명령은 기존 슬래시 팔레트(`renderer/src/components/Palette.tsx` `COMMANDS`)에 슬롯으로 추가하되, `/clear`·`/compact`는 채팅 텍스트로 전송하지 않고 **클라이언트가 가로채** 전용 ws 메시지를 보낸다. ⋯ 메뉴(`Channels.tsx`)에도 같은 두 동작 버튼.

### chat-store (`src/edge/messenger/chat-store.ts`)
- `clearChannel(id)` → jsonl을 `${id}.jsonl.cleared`로 원자적 rename(백업 1개 유지, 기존 백업 있으면 삭제). 파일 없으면 no-op.
- `undoClear(id)` → 백업을 다시 jsonl로 rename(복원). 백업 없으면 false.
- `dropClearBackup(id)` → 백업 완전 삭제(토스트 만료/다음 clear/부팅 정리).
- 셋 다 never-throw·원자적(S4 프루닝 관례 계승). 위키/RAG 무관.

### compact 로직 (신규 서비스 or 오케스트레이터 경로)
1. `history(channelId)`로 대화를 읽어 채널 브레인에게 요약 프롬프트(신규 `compact-summary` 프롬프트, 로케일 대응).
2. 요약을 채널에 **메시지로 append**(작성자=Engram, "요약해서 정리했어요" + 본문 + "📄 위키에 저장됨: [slug]" 푸터).
3. 위키에 저장: 저장 전 `wiki_search`로 유사 페이지 찾고 있으면 그 slug로 append, 없으면 신규(dedup 규칙). propose+approve 한 턴에. auto-compact는 `auto-compact` 태그 포함.
4. 그 요약 메시지 1줄만 남기고 이전 기록 정리(clearChannel 후 요약 메시지 재기록, 또는 요약을 남기고 그 앞을 자름). **요약 메시지는 되돌리기 대상 아님**(방금 저장한 앵커).

### auto-compact 훅 (retention)
- `appendMessage`의 프루닝 직전(`pruneChannel`이 자를 줄이 있을 때), auto-compact 토글이 켜져 있으면 잘려나갈 구간을 요약→위키 게시 후 프루닝. 토글 off면 기존 S4대로 그냥 프루닝.
- AI 호출이 매 프루닝마다는 과하므로: 프루닝이 실제로 줄을 버릴 때만·디바운스(같은 채널 짧은 시간 다발 프루닝은 1회로 묶음). 실패는 never-throw(요약 실패해도 프루닝/append는 계속 — 단 지식 유실 방지가 목적이므로 실패 시 프루닝을 건너뛰는 옵션은 플랜에서 결정).

### ws 프로토콜 (renderer ↔ edge)
- `clearHistory {channelId}` → clearChannel, broadcast 갱신. 응답에 undo 가능 표시.
- `undoClear {channelId}` → undoClear, broadcast.
- `compact {channelId}` → compact 로직 실행, 결과(요약 메시지+wiki slug) broadcast.
- owner/멤버 권한: 자기 채널 대화 정리는 채팅 참여자 권한과 동급(별도 관리 권한 불필요). 팀 공유 채널은 기존 canManage 게이트 준수.

### 설정 (retention + auto-compact 토글)
- `chat.config.ts`에 `autoCompact: boolean`(기본 true) 추가(saveChatBootConfig 부분갱신 관례).
- **서버 콘솔 ⑨**: 대화 보존 select 아래 자동 정리 토글(admin-http server-settings GET/POST 확장, retentionTouched처럼 touched 게이트).
- **데스크톱 개인앱 설정**: 보존 select + 자동 정리 토글을 데스크톱 설정 UI에도 추가(현재 보존 UI는 서버 콘솔에만 있음 — 이번에 데스크톱에도). 목업 ⑤ 참조.

### 되돌리기 토스트 (renderer)
- /clear 후 ~6초 토스트(메시지 아님, 오버레이). "실행취소" 클릭 → `undoClear`. 만료/다음 clear → `dropClearBackup`. 순수 클라 타이머 + 서버 백업.

## UI (목업 픽셀)

① 슬래시 팔레트에 `/clear`·`/compact` · ② ⋯ 메뉴 2버튼 · ③ /clear 즉시(모달·메시지 없음)+실행취소 토스트 · ④ /compact 요약 메시지+위키 저장 표시+구분선 · ⑤ auto-compact 시스템 줄 + 보존 옆 자동정리 토글(기본 켜짐, 서버 콘솔+데스크톱 공통). en 기본+ko. 목록 행 .grp/msgs 직계(구분선 회귀 방지).

## 범위 밖

- 컨텍스트 토큰 게이지(Engram은 6턴 고정창이라 비적용).
- 요약 편집 UI(미리보기 없이 바로 — 사용자 결정). 사후 위키에서 편집.
- CLI 하네스 내부 컨텍스트 관리(하네스가 자체 처리).

## 태스크 분해(초안, 플랜에서 확정)

1. chat-store clearChannel/undoClear/dropClearBackup (+spec).
2. compact 로직(요약→메시지→위키 저장→정리) + compact-summary 프롬프트.
3. auto-compact retention 훅 + chat.config autoCompact.
4. ws 프로토콜(clearHistory/undoClear/compact) + edge 핸들러·권한.
5. renderer: 팔레트 2명령 인터셉트 + ⋯ 메뉴 2버튼 + /compact 요약 메시지 렌더 + 실행취소 토스트.
6. 설정 UI: 서버 콘솔 자동정리 토글 + 데스크톱 보존/자동정리 설정.
7. 실스모크(실서버: /clear+undo·/compact 위키 저장 실증·위키 불변·auto-compact 프루닝 직전 게시).
