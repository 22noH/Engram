# 올라마 다중 두뇌 등록 — 설계

날짜: 2026-07-17
상태: 승인됨 (브레인스토밍 완료)

## 1. 문제

설정창의 "로컬 두뇌 추가"는 항상 `'ollama'`라는 고정 이름으로 brains.json에 저장한다
(`src/desktop/ollama.ts`의 `addOllamaProfile`). 두 번째 모델을 추가하면 첫 번째가
소리 없이 덮어써져서, qwen과 gemma를 동시에 등록해 두고 지휘자 위임(Phase 8d,
`ask_brain`)으로 골라 쓰는 것이 UI로는 불가능하다. 등록된 두뇌를 지우는 UI도 없다.

brains.json 자체는 이름만 다르면 여러 프로필을 담을 수 있고(`src/brain/brain.config.ts`),
기본 두뇌 드롭다운(`listBrains`/`setDefaultBrain`)은 8b-2가 이미 만들었다. 빈 구멍은
"이름을 달리해 여러 개 등록"과 "삭제" 둘뿐이다.

## 2. 목표 / 비목표

목표:
- 설정창에서 올라마 모델별 두뇌를 여러 개 등록 (이름 자동 제안 + 수정 가능)
- 등록된 두뇌 목록 표시 + 삭제 (기본 두뇌는 삭제 불가)

비목표 (이월 — 잊지 말 것):
- **두뇌 전면 관리 UI** (프로필 편집·이름변경·API 키 관리 표) → **"설정 전면 UI화"
  페이즈의 필수 포함 항목**으로 이월. 이 페이즈 착수 시 본 스펙의 §5 목록을 흡수할 것.
- **채팅별 두뇌 선택 UI** (채널/대화마다 두뇌 지정, 서버가 여러 두뇌 동시 탑재) →
  설정 전면 UI화 **다음** 페이즈. 그때까지는 8d 지휘자 위임("gemma한테 물어봐")으로 충분.
- 서버(src/agent-layer, src/brain, src/edge) 코드 변경 없음 — 순수 데스크톱/설정 작업.

## 3. 설계

### 3.1 데스크톱 순수 함수 (src/desktop/brains-file.ts)

- `removeBrainProfile(configDir, key): void` 신규.
  - brains.json에서 `brains[key]` 삭제 후 저장.
  - **key가 현재 default면 no-op** — 기본 두뇌가 사라지면 서버가 시작을 못 하므로
    UI 비활성과 별개로 파일 계층이 최종 안전선.
  - 파일 없음/깨짐/없는 key → no-op. (`setDefaultBrain`과 같은 결.)
- `slugFromModel(model): string` 신규: `qwen3:8b` → `qwen3-8b`.
  소문자화, 영숫자 외 문자(`:` `/` `.` 등)는 `-`로, 연속 `-` 축약, 양끝 `-` 제거,
  빈 결과면 `'ollama'` 폴백. 위임 때 채팅에서 이름으로 부르므로 부르기 쉬운 형태.
- 기존 `mergeBrainProfile`·`listBrains`·`setDefaultBrain` 무변경.

### 3.2 ollama.ts

- `addOllamaProfile(configDir, model, name, setDefault)` — `name` 인자 추가(3번째).
  고정 `'ollama'` 대신 `name`으로 `mergeBrainProfile` 호출. 호출부는 설정창 IPC 하나뿐.

### 3.3 IPC + preload (src/desktop/main.ts, preload.ts)

- `engram:add-ollama` 핸들러 `(model, name, setDefault)` 3인자로 확장.
- `engram:remove-brain` 신규 → `removeBrainProfile(configDir, key)`.
- preload: `addOllama(model, name, setDefault)` 시그니처 갱신, `removeBrain(key)` 신규.
- `engram:slug-model` 신규 IPC → `slugFromModel`. (preload는 Electron 기본 샌드박스라
  로컬 모듈 import 불가 — 다른 `engram:*`와 같은 invoke 패턴으로 통일. 로직은
  brains-file.ts 한 곳에만 존재하고 테스트도 거기.)
- `listBrains`·`setDefaultBrain` IPC는 8b-2 것 재사용.

### 3.4 설정창 UI (src/desktop/settings.html)

- **추가 행**: `[모델 ▾] [이름 입력란] [☑ 기본으로] [추가]`.
  - 모델 선택 변경 시 이름란을 `slugFromModel`로 자동 채움. 사용자가 이름란을 직접
    수정한 뒤에는(dirty 플래그) 덮어쓰지 않음.
  - 이름이 이미 등록돼 있으면 추가 버튼 라벨이 "Overwrite"(ko: "덮어쓰기")로 바뀜 —
    모달 없이 조용한 데이터 손실만 방지. 빈 이름이면 추가 버튼 비활성.
- **등록 목록 (신규)**: 두뇌 섹션에 `listBrains()` 결과를 한 줄씩 —
  `이름 · provider/model · [삭제]`. 기본 두뇌 줄은 `default` 배지 + 삭제 버튼
  비활성(title 툴팁: 다른 두뇌를 먼저 기본으로). 삭제/추가 후 목록·기본 두뇌
  드롭다운 즉시 갱신, "재시작하면 적용" 문구는 기존 패턴 그대로.
- **기본 두뇌 드롭다운**: 8b-2 그대로 (목록만 늘어남).
- i18n: 이름 라벨·이름 힌트("이 이름으로 채팅에서 부릅니다")·삭제·덮어쓰기·
  기본두뇌 삭제불가 툴팁. 영어 기본 + ko.
- 목업: 브레인스토밍에서 확정 (추가 행 + 테두리 목록 + 드롭다운, 앱 팔레트 준수).

### 3.5 지우기 정책

- 삭제 대상은 provider 불문 **기본이 아닌 모든 프로필** (올라마·API·CLI 동일 규칙).
  brains.json은 파일 삭제가 아니라 항목 삭제이므로 되돌림은 재등록으로 충분.
- 확인 모달 없음 — 실수 비용이 낮고(재등록 몇 초) 흐름이 가벼운 쪽이 맞음.

## 4. 테스트

- `brains-file.spec.ts`:
  - `removeBrainProfile` — 일반 삭제·default 거부 no-op·없는 key no-op·파일 없음/깨짐 no-op.
  - `slugFromModel` — `qwen3:8b`→`qwen3-8b`, `hf.co/org/model.Q4`류, 빈/특수문자만 폴백.
- `ollama.spec.ts`: `addOllamaProfile`에 이름 인자 반영 — **서로 다른 이름으로 두 모델
  등록 시 둘 다 남는 것**(이번 작업의 존재 이유인 회귀 테스트).
- 설정창 렌더러: 기존 settings.html 테스트 방식이 있으면 그에 맞춰 dirty 플래그·
  덮어쓰기 라벨 로직 검증, 없으면 순수 함수로 뽑을 수 있는 부분(slug)만 유닛.
  실 Electron 스모크는 수동.

## 5. "설정 전면 UI화" 페이즈로 이월하는 것 (본 스펙 발 항목)

- 두뇌 프로필 편집(모델·baseUrl·단가 수정)·이름변경 UI
- API 두뇌(anthropic-api) 다중 등록·키 관리 표
- 그 다음 페이즈: 채팅별 두뇌 선택 UI(서버 다중 두뇌 동시 탑재 포함)

## 6. 참고 하드웨어 맥락

사용자 GPU는 RTX 4060 Ti 8GB — 여러 모델을 등록해도 올라마가 한 번에 하나만 VRAM에
태우고 전환 시 스왑(수 초)한다. 이번 작업은 "동시 실행"이 아니라 "동시 등록 + 위임
선택"을 가능하게 하는 것.
