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
