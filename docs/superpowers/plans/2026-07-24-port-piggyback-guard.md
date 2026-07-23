# 포트 피기백 가드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 두 번째 Engram 인스턴스가 고정 포트(47800)에 이미 떠 있는 다른 인스턴스의 서버에 조용히 붙어 남의 데이터를 보여주는 사고를 감지하고 명확히 실패시킨다.

**배경(스펙):** 데스크톱 셸은 자식 데몬을 띄운 뒤 HTTP 헬스 폴링이 성공하면 창을 로드한다. 자식이 EADDRINUSE로 못 떠도 **다른 인스턴스**가 같은 포트에서 헬스에 응답하면 폴링이 성공해 창이 남의 라이브 서버(ws://127.0.0.1:47800)에 붙는다 — 코드 패널 T4 실측에서 실제 발생(격리 하네스로 적발, task-4-report "Concerns").

**설계 결정:** 자동 포트 재배정이 아니라 **명확한 에러+종료**. 근거: 같은 userData 이중 실행은 기존 single-instance 락이 막고, 의도적 다중 실행(개발·하네스)은 `ENGRAM_CHAT_PORT`/`ENGRAM_USERDATA_DIR` 오버라이드가 이미 있다. 우발적 이중 인스턴스(별도 설치본 등)에는 조용한 피기백 대신 정직한 실패가 옳다(자동 재배정=렌더러 연결 시딩 개편이 필요한 기능 추가, YAGNI).

**메커니즘:** 부팅마다 데스크톱이 랜덤 인스턴스 id 생성 → 자식 데몬 env `ENGRAM_INSTANCE_ID` → 헬스 응답(JSON)에 에코(additive 필드, env 부재 시 필드 생략=기존 응답 그대로) → 데스크톱 헬스 폴링이 id 대조 → 불일치=외부 인스턴스 → `dialog.showErrorBox`(양언어 아닌 시스템 로케일 기준 한 문구 — 데스크톱 다이얼로그 관례 확인 후 en 기본) 후 `app.quit()`.

## Global Constraints

- **회귀 0**: 정상 단일 인스턴스 부팅 경로 동작 불변(폴링 성공 조건에 id 일치 추가일 뿐, env 전달·에코 필드는 additive). `ENGRAM_INSTANCE_ID` 미설정 데몬(수동 `node dist/src/main.js`·도커·서버 에디션)의 헬스 응답 byte-identical.
- 헬스 응답에 dataDir 경로 등 내부 정보 새로 노출 금지(랜덤 id 에코만).
- 로컬 브레인 fork(47801+)는 각자 별개 id를 받거나 검사 제외 — 기존 브레인 부팅·감독 로직 무변경(브레인 헬스 폴링이 있으면 동일 가드, 없으면 손대지 않음 — 실코드 확인 후 보고).
- never-throw·기존 폴링 타임아웃 의미 유지(불일치는 즉시 실패 — 타임아웃 대기 아님).
- 커밋 Co-Authored-By 금지·무관 파일 스테이징 금지·jest 포그라운드.

---

### Task 1: 헬스 에코(백엔드) + 데스크톱 가드

**Files:**
- Modify: `src/edge/messenger/self.adapter.ts`(헬스 응답 — GET `/` 프로브 JSON에 `instanceId` 조건부 에코), `src/desktop/main.ts`(id 생성·자식 env 전달·폴링 대조·에러 다이얼로그+종료)
- Test: 백엔드 — self.adapter 헬스 케이스 2개(env 있음=에코·없음=필드 생략 byte-identical). 데스크톱 — 폴링 대조 로직을 순수 함수로 추출(`checkHealthIdentity(json, expectedId): 'ok'|'foreign'|'pending'` 류)해 유닛 테스트(일치/불일치/필드 부재[구버전 데몬=불일치 취급 — 구버전과 새 셸 조합은 외부 인스턴스와 구분 불가하므로 안전측]·JSON 아님). 다이얼로그·quit은 얇은 글루.

**Steps:**
- [ ] Step 1: TDD — 위 테스트 RED→GREEN. 헬스 폴링 루프에 대조 삽입(불일치 즉시 중단·안내). 필드 부재 처리 결정 명시: expectedId를 보냈는데 응답에 없으면 'foreign'(안전측 — 자식은 반드시 에코하므로 정상 경로 무영향).
- [ ] Step 2: 실검증 — 격리 하네스(ENGRAM_USERDATA_DIR+포트 기본값)로 두 번째 인스턴스 기동 → 에러 다이얼로그 확인(T4 방식 재사용, 사용자 실앱 무접촉). 로컬 브레인 fork 경로 무변경 확인.
- [ ] Step 3: full `npm test`·build. `git commit -m "fix(desktop): 포트 피기백 가드 — 인스턴스 id 헬스 에코+불일치시 명확한 실패(조용한 남의 서버 접속 차단)"`

## Self-Review 결과

- 요구 커버: 감지(id 대조)·명확한 실패·회귀 0(additive 에코·정상 경로 불변)·구버전 데몬 조합=안전측 처리 명시.
- 비목표: 자동 포트 재배정·원격/서버 에디션 가드(헬스 에코는 무해하게 공통, 가드는 데스크톱만).
