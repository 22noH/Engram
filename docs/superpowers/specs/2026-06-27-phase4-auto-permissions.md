# Phase 4 후속 — 자동 권한 모드 (사용성)

> 상위: [Phase 4 설계](2026-06-27-phase4-autonomous-coding-design.md) · 작성 2026-06-27 · 상태: 구현

## 문제
Phase 4는 안전하게 fail-closed지만, 쓰려면 `runtime/config/permissions.json`(writePaths·tools)과 페르소나 `tools:` 프론트매터를 손으로 깔아야 했다 → 못 쓸 UX. 사용자 결정: **AI의 목적이 자동화니 기본은 자동모드.**

## 확정 결정
- **기본 = 자동.** `engram code <폴더> "목표"`에서 **폴더 인자 = 동의.** 별도 묻거나 JSON 편집 0.
- **안전 비협상(자동모드에서도 무조건, config 무관)**: 백스톱이 거부 —
  - Engram 자기 repo 루트(findRepoRoot, 기존)
  - 시스템 폴더 기본 denyPaths: `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`
- **writePaths는 선택적 strict 모드**: 비어있으면(자동 기본) 백스톱 밖 경로는 허용; 비어있지 않으면 그 allowlist 강제(엄격 운영용). → 명시한 타깃 폴더는 통과, 자기파괴·시스템 손상은 구조적 차단.
- **코딩 도구**: 페르소나 frontmatter/grant에 의존하지 않고 **표준 파일 toolset 기본 부여**(Edit·Write·Read·Glob·Grep), `--add-dir <타깃>`로 스코프. (Phase 3 협업 페르소나의 default-deny 도구 모델은 그대로 — 코딩만 자동.)
  - **★Bash 제외(보안)**: `--add-dir`는 *파일 도구*만 가두지 샌드박스 없는 Bash는 임의 셸로 울타리를 빠져나가 자기 repo·홈·시스템에 쓸 수 있다. 명령 실행(테스트·빌드)은 에이전트가 아니라 **VerificationGate(Engram)가 직접** 하므로 코딩 에이전트엔 Bash 불필요. Bash 자율은 OS 샌드박스 붙인 후속 모드로 보류. → 이걸로 "폴더=동의"가 실제로 참(파일 도구가 타깃에 갇힘).
- **SYSTEM_DENY**: env 해소(SystemRoot·ProgramFiles·ProgramData 등) + 하드코딩 폴백.
- **헤드리스 자율 실행**: CodingSpecialist가 claude에 `--permission-mode acceptEdits` 전달 → 울타리 범위 안에서 묻지 않고 편집.
- **`--confirm`(옵션)**: 시작 전 계획 보여주고 `[시작/취소]`. 안 쓰면 바로 달림.

## 범위
- PermissionFence: 내장 SYSTEM_DENY + writePaths-선택적 assertWritable + 표준 코딩 toolset codingFlags.
- CodingSpecialist: `--permission-mode acceptEdits` + 표준 toolset.
- CLI `code()`: 자동 기본(프롬프트 생략) + `--confirm`.
- 매-동작 대화 승인은 **안 함**(headless `claude -p`엔 안 뜨고 자율 비전과 충돌 — 그건 대화형 claude의 일).

## 안 바꾸는 것
- 게이트 하드 바닥(Engram 직접 실행)·리뷰어·stuck·run-state — 그대로.
- 자기수정 백스톱 — 강화만(시스템 폴더 추가).
