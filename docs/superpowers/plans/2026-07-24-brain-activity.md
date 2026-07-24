# 두뇌 활동 표시 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended). Steps use checkbox syntax.

**Goal:** 답을 기다리는 동안 두뇌가 지금 뭘 하는지("웹 검색 중 · web_search") 실시간 표시하고, 완료된 답 위에 사용 도구 요약 한 줄을 남긴다(목업 승인 2026-07-24).

**Architecture:** ①휘발 `activity` ServerFrame(저장 안 함 — 브로드캐스트만) ②완료 메시지에 additive `toolsUsed?: string[]`(chat-store allow-list 등재) ③CompleteOpts.onTool 콜백을 delegate/askUser 관례로 주입 — 자체 하네스(tool-loop)와 Claude CLI(stream-json tool_use 이벤트) 양쪽에서 발화.

## Global Constraints

- 회귀 0: onTool 미주입·activity 미구독 시 전 경로 byte-identical. activity 프레임은 절대 저장 안 함(jsonl 불변). ⚠️appendMessage allow-list에 `toolsUsed` 등재.
- 도구 이름→표시 라벨은 서버 로케일(기존 agent-layer t() 관례)로: wiki_search=위키 검색/web_search=웹 검색/fetch_url=페이지 읽기/Bash·코딩 도구=코드 작업/ask_brain=다른 모델에 위임/ask_user=질문 게시/MCP 접두=도구 이름 그대로. 미지의 이름=이름 그대로(절대 누락 크래시 없음).
- 비-self 어댑터(activity 미지원)는 no-op(옵셔널 포트 메서드). 커밋 Co-Authored-By 금지·jest 포그라운드·무관 파일 스테이징 금지.

---

### Task 1: 백엔드 — activity 프레임·toolsUsed·onTool 관통

**Files:**
- Modify: `shared/protocol.ts`(ServerFrame `{t:'activity'; channelId: string; label: string}`+Message.toolsUsed), `src/edge/messenger/chat-store.ts`(allow-list+ChatMessage 타입), `src/edge/messenger/messenger.port.ts`(옵셔널 `activity?(channelId,label)`+reply 5번째 `toolsUsed?`), `src/edge/messenger/self.adapter.ts`(activity=broadcastToChannel·reply toolsUsed 저장), `src/edge/messenger/messenger-bridge.ts`(orchestrator에 activity fn+post toolsUsed 관통), `src/agent-layer/orchestrator.ts`(PostFn meta 확장·reader-agent 호출에 activity 전달), `src/agent-layer/reader-agent.ts`(CompleteOpts.onTool 주입: 라벨 매핑+seq 카운트+toolsUsed 수집 — 응답 post 시 동봉), `src/brain/brain.port.ts`(CompleteOpts.onTool?: (name: string, seq: number) => void), `src/brain/tool-loop.ts` 또는 anthropic/openai 실행부(도구 실행 직전 onTool 발화·never-throw 격리), `src/brain/claude-cli.brain.ts`(stream-json 파싱서 tool_use 이벤트→onTool — 기존 파서 위치 확인)
- 라벨 매핑: `src/agent-layer/tool-labels.ts`(+spec — 순수 함수, ko/en)

**Steps:**
- [ ] TDD: tool-labels 매핑(알려진 7종+미지 폴백)/tool-loop onTool 발화(순서·이름·never-throw)/CLI 파서 tool_use→onTool/reader-agent 수집·라벨·post 동봉/adapter activity 브로드캐스트(실ws)+toolsUsed 저장 왕복+비저장(activity) 확인. RED→GREEN.
- [ ] full test·build. `git commit -m "feat(activity): 두뇌 활동 프레임+도구 요약(onTool 관통·CLI stream-json·휘발 브로드캐스트)"`

### Task 2: 렌더러 — 대기 인디케이터 갱신+요약 줄(목업 픽셀)

**Files:**
- Modify: `renderer/src/App.tsx`(onFrame 'activity'→채널별 awaiting 라벨 상태·응답 도착 시 클리어), `renderer/src/components/Message.tsx`(m.toolsUsed 요약 줄 — 목업 ②: 🔧 도구 N개 사용 — 이름 ×횟수·대시 보더), 인디케이터 컴포넌트(기존 awaiting 표시 위치 확인·라벨 치환), `renderer/src/i18n.ts`, `renderer/src/theme.css`(.toolsUsed .activityLabel — QL 토큰)
- 규칙: activity는 해당 채널 awaiting 중일 때만 반영(늦게 온 프레임 무시)·question/actions와 공존.

**Steps:**
- [ ] TDD(vitest): activity 프레임→인디케이터 라벨 갱신/응답 도착→클리어/toolsUsed 렌더(개수·×횟수 포맷·없으면 미렌더 byte-identical)/타 채널 activity 무영향. RED→GREEN.
- [ ] 렌더러 full·tsc·build+백엔드 회귀. `git commit -m "feat(activity): 대기 인디케이터 실시간 라벨+답 도구 요약 줄 — 목업 픽셀"`

### Task 3: 실스모크+릴리스 동승

- [ ] `scripts/smoke-activity.ts` — 실서버+mock 두뇌(도구 2회 사용 시나리오): activity 프레임 2회 수신(라벨 정확)·최종 msg.toolsUsed 정확·jsonl에 activity 부재·재시작 후 toolsUsed 보존. 2회 PASS.
- [ ] full 전체+양 빌드. `git commit -m "test(activity): 실스모크(활동 프레임 휘발·요약 영속)"` → v0.0.11 태그(스크롤바·체크박스 픽스 동승).

## Self-Review

- 커버: 프레임·수집·양 하네스·렌더·휘발/영속 경계·스모크. 함정 명시: allow-list·never-throw 콜백·늦은 프레임 무시.
- 불확실(구현 확정·보고): CLI stream-json tool_use 이벤트 실형태·기존 awaiting 인디케이터 구현 위치.

### Task 4: 여러 줄 입력 + 생성 중지 (사용자 요청 2026-07-24·목업 게시)

**요구:** ①입력창 textarea 자동 높이(최대 ~6줄) — Enter=전송·Shift+Enter=줄바꿈, 팔레트/멘션 키 상호작용 보존 ②생성 중: 보내기 버튼→■ 중지(danger 아웃라인)+Esc 동일, `{t:'stopGeneration'; channelId}` additive 프레임 → 서버가 그 채널의 진행 중 턴 abort(무턴이면 조용히 무시) → 두뇌 abort(자체 하네스=AbortSignal→기존 ctrl 연동·CLI=자식 프로세스 kill) → "⏹ 중단됨"(i18n) 메시지 게시+awaiting 해제.

**Files:** shared/protocol.ts(프레임)·self.adapter(프레임→핸들러)·orchestrator(threadKey별 AbortController 레지스트리·중단 메시지)·brain.port.ts(CompleteOpts.signal?)·anthropic/openai(기존 내부 ctrl에 외부 signal 연동)·claude-cli(spawn abort→kill)·renderer App(textarea 전환·버튼 스왑·Esc)·i18n·theme.css.

- [ ] TDD: textarea Enter/Shift+Enter·팔레트 키 회귀/stop 프레임→abort 호출·무턴 무시/anthropic signal abort→루프 중단/CLI kill/중단 메시지 게시·awaiting 해제/버튼 스왑·Esc. 회귀 0(중지 미사용 경로 byte-identical).
- [ ] full+렌더러+빌드. `git commit -m "feat(input): Shift+Enter 줄바꿈+생성 중지(■/Esc·서버 abort 관통)"`
