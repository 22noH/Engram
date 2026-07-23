# 채팅 첨부 — 이미지 붙여넣기·파일 첨부, 두뇌가 보고 이해

날짜: 2026-07-23 · 상태: 설계 확정(목업 A 사용자 승인)

## 목적

채팅에 캡처 이미지 붙여넣기·파일 첨부를 지원하고, **두뇌가 첨부를 직접 보고 이해**한다(이미지=vision, 텍스트계 파일=내용 읽기).

## UI (목업 확정)

- 입력: 입력창 왼쪽 **클립 버튼**(파일 선택), **Ctrl+V**(클립보드 이미지 캡처), **드래그앤드롭**. 첨부하면 입력창 위에 **전송 전 미리보기 칩**(파일명+X 제거)이 뜨고, Send로 메시지와 함께 전송.
- 표시: 이미지=내 버블 안 **인라인 썸네일**(클릭=원본 보기), 파일=**칩**(아이콘·이름·타입·크기, 클릭=열기/저장). Quiet Library 토큰 그대로.
- 상한: 파일당 20MB·메시지당 5개(기본값 — 코드 상수). 초과 시 칩 단계에서 안내(전송 차단).

## 데이터·전송

- `Message`에 additive 필드 `attachments?: Array<{ id: string; name: string; mime: string; size: number }>` — ⚠️ chat-store `appendMessage` input 스프레드(allow-list)에 등재 필수.
- 실파일: `dataDir/attachments/<channelId>/<id>`(id=서버 발급 uuid, 확장자 보존). 사용자 파일명은 메타데이터로만(경로에 미사용 — traversal 원천 차단).
- 업로드/다운로드는 **기존 서버 HTTP에 세션 게이트 엔드포인트 추가**(ws 바이너리 미사용 — 원격 preset 클라이언트도 동일 경로):
  - `POST /attachments/<channelId>` (multipart 또는 raw body+헤더) → `{id}` — 인증 모드=세션 토큰 게이트+`canAccessChannel`, 무인증 모드=기존 루프백 규칙 재사용. 크기·개수 상한 서버 강제.
  - `GET /attachments/<channelId>/<id>` — 동일 게이트. Content-Type은 저장된 mime(화이트리스트 밖은 `application/octet-stream`)+`Content-Disposition` 파일명.
- send 프레임에 `attachments: id[]` additive — 서버가 실재하는 id만 메시지에 스탬프(위조 id 무시).

## 두뇌 활용

- `MentionEvent`에 첨부 메타+로컬 경로 전달(additive).
- **자체 하네스**: 이미지(png/jpg/gif/webp)는 Anthropic API 이미지 블록(base64)으로. OpenAI 호환(로컬 LLM)의 vision 지원 여부는 플랜에서 실코드 조사 — 지원 시 image_url(base64), 미지원 모델은 폴백. 텍스트계 파일(md/txt/log/json/코드 확장자, 256KB 상한)은 내용을 프롬프트에 삽입(상한 초과분은 앞부분+생략 표시).
- **Claude CLI 하네스**: 파일 **절대경로**를 프롬프트에 명시(CLI가 로컬 파일을 직접 읽음/봄).
- **폴백**: vision 미지원·바이너리 비텍스트 파일은 `[Attachment: 이름 (타입, 크기)]` 텍스트로 존재만 알림. 차단 없음.

## 보존 (사용자 확정: 메시지와 운명 공유)

- 보존정책 프루닝·자동요약 정리·`/clear`로 메시지가 제거되면 그 메시지의 첨부 실파일도 삭제.
- 단 `/clear` 실행취소 유예 동안은 백업(.cleared)과 함께 파일 보존 — `dropClearBackup` 시점에 삭제, `undoClear` 시 그대로 복귀.
- 삭제는 never-throw(파일 잠김 등 실패 시 로그만 — 고아 파일은 무해, 차기 정리 후보).
- 중요한 이미지는 위키에 올려 영구 보존(별도 기능·비목표).

## 안전선

- 경로는 서버 발급 uuid만 사용·channelId는 기존 safeId 검증. 게이트는 기존 세션/채널 접근 규칙 재사용(새 우회 경로 금지).
- 회귀 0: attachments 없는 메시지의 저장·전송·렌더·두뇌 경로 byte-identical.
- 업로드 응답·에러에 서버 내부 경로 미노출.

## 비목표

위키 페이지 첨부·이미지 편집·외부 URL 임베드·첨부 검색/RAG 색인(후속 후보).
