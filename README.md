# Engram

개인용 **stateful LLM 위키(지식 코어)** 를 단일 진실원으로 두고, 에이전트 무리가 그것을 **읽고(A)·협업하고(B)·자율 갱신(C)** 하는 24/7 셀프호스팅 멀티에이전트 시스템.

> 뇌에 저장된 기억의 물리적 흔적(*engram*). stateful 위키(기억 코어)를 은유.

## 문서

- **[설계 문서 (docs/DESIGN.md)](docs/DESIGN.md)** — 아키텍처·결정·로드맵의 단일 기준선

## 상태

설계 확정 — **Phase 0 (KnowledgeCore)** 착수 예정.

## 스택

Node 22+ · NestJS · TypeScript · **LanceDB** · 로컬 임베딩(다국어) · 두뇌 **Claude CLI** (`IBrainProvider` 포트로 교체 가능)

## 플랫폼

**Windows 네이티브 우선** → macOS → Linux. Docker는 선택.

## 빌드 로드맵

1. **Phase 0** — KnowledgeCore (WikiEngine + RagStore + 수집 1경로)
2. **Phase 1** — A 읽기 (ReaderAgent + CLI Gateway)
3. **Phase 2** — C 자율쓰기 (IngesterAgent + 검증 파이프라인 + 승인 게이트)
4. **Phase 3** — B 협업 (Orchestrator + 8팀 + Board Meeting)
5. **Phase 4** — 자율 코딩 협업 (`engram code`)
6. **Phase 5** — InsightLayer + 운영(PAL)

## 운영 (PAL)

24/7 상주를 위한 서비스 등록·감시(Phase 5):

- **서비스 등록**: `engram service install | uninstall | start | stop | status`
  - Windows = Windows 서비스(node-windows), Linux = systemd user 유닛, macOS = launchd LaunchAgent. 부팅 자동시작 + 죽으면 OS가 재시작.
  - ⚠️ Linux/macOS 서비스의 실제 동작은 해당 OS에서 검증 필요(개발은 Windows 우선).
- **감시자(watchdog)**: 별도 경량 프로세스 `node dist/src/watchdog.js`. 상주가 1분마다 찍는 심장박동이 끊기면(멈춤·죽음) 강제종료(→OS 재시작) + 외부 알림.
- **알림 설정**: `runtime/config/alert.json`에 `{ "webhookUrl": "...", "command": "..." }`(둘 다 선택). 멈춤·메모리 임계치 초과 시 발사.
- **인사이트**: `engram insights` (최신 일일 리포트) · `engram insights run` (즉시 생성).
