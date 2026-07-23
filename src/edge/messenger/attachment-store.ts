import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { AttachmentMeta } from '../../../shared/protocol';
import type { ChatMessage } from './chat-store';
import { safeId } from './chat-store';

// 채팅 첨부 실체 저장소(스펙: docs/superpowers/specs/2026-07-23-chat-attachments-design.md).
// 실파일: dataDir/attachments/<channelId>/<id>(id=서버 발급 uuid, 원본 확장자 보존). 사용자 파일명은
// 사이드카 <id>.json 메타로만 보존 — 경로엔 절대 쓰지 않는다(traversal 원천 차단). 전부 동기 fs.
// channelId 검증은 chat-store의 safeId를 그대로 재사용(같은 신뢰 경계·중복 구현 회피).
//
// 삭제(deleteFor)는 never-throw — 메시지와 첨부가 "운명을 공유"하는 지점(pruneChannel/
// removeMessagesByIds/dropClearBackup, chat-store.ts)에서 호출되며 실패해도 대화 삭제 자체를
// 막아선 안 된다(로그만 남기고 계속 — 고아 파일은 무해, 차기 정리 후보).
//
// deleteFor(messages)는 channelId를 받지 않는다(브리프 인터페이스 그대로) — 첨부 id는 randomUUID+
// 확장자라 사실상 전역 고유이므로, attachments/ 아래 채널 디렉터리들을 훑어 일치하는 파일만 지운다.

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20MB(스펙 상한, 코드 상수)

// 저장 시 발급한 id(uuid[+확장자]) 형태만 인정 — path()/meta()로 위조 id가 들어와도 실재 파일 존재
// 여부와 별개로 구조부터 걸러 불필요한 fs 접근을 줄인다. uuid 뒤에 .ext(영숫자 1~10자)까지만 허용.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[A-Za-z0-9]{1,10})?$/;

function isValidAttachmentId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

export class AttachmentStore {
  constructor(private readonly dataDir: string) {}

  private baseDir(): string {
    return path.join(this.dataDir, 'attachments');
  }

  private channelDir(channelId: string): string {
    return path.join(this.baseDir(), channelId);
  }

  private filePath(channelId: string, id: string): string {
    return path.join(this.channelDir(channelId), id);
  }

  private metaPath(channelId: string, id: string): string {
    return path.join(this.channelDir(channelId), `${id}.json`);
  }

  // 상한(20MB)·channelId 검증 후 저장. id=randomUUID()+원본 확장자(있으면). 실패 시 null(never-throw).
  save(channelId: string, name: string, mime: string, data: Buffer): AttachmentMeta | null {
    try {
      if (!safeId(channelId)) return null;
      if (!Buffer.isBuffer(data) || data.length === 0 || data.length > MAX_ATTACHMENT_BYTES) return null;
      const rawExt = path.extname(typeof name === 'string' ? name : '');
      // 확장자는 파일명에 그대로 쓰이므로 영숫자만 허용(경로 구멍·과도한 길이 방지).
      const ext = /^\.[A-Za-z0-9]{1,10}$/.test(rawExt) ? rawExt : '';
      const id = randomUUID() + ext;
      const dir = this.channelDir(channelId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath(channelId, id), data);
      const meta: AttachmentMeta = {
        id,
        name: typeof name === 'string' && name.trim() ? name : id,
        mime: typeof mime === 'string' && mime.trim() ? mime : 'application/octet-stream',
        size: data.length,
      };
      fs.writeFileSync(this.metaPath(channelId, id), JSON.stringify(meta));
      return meta;
    } catch (e) {
      console.warn(`[attachment-store] 채널 '${channelId}' 첨부 저장 실패: ${String(e)}`);
      return null;
    }
  }

  // 실재하는(서버가 발급한 uuid 형태 + 실제 파일 존재) 첨부만 경로를 돌려준다. 위조/미존재 id는 null.
  path(channelId: string, id: string): string | null {
    if (!safeId(channelId) || !isValidAttachmentId(id)) return null;
    const p = this.filePath(channelId, id);
    try {
      if (!fs.statSync(p).isFile()) return null;
    } catch {
      return null; // 없음/접근 불가
    }
    return p;
  }

  // 사이드카 <id>.json 메타 반환. 손상/미존재/형태 불일치는 null(never-throw).
  meta(channelId: string, id: string): AttachmentMeta | null {
    if (!safeId(channelId) || !isValidAttachmentId(id)) return null;
    try {
      const raw = fs.readFileSync(this.metaPath(channelId, id), 'utf8');
      const parsed = JSON.parse(raw);
      if (
        !parsed ||
        typeof parsed.id !== 'string' ||
        typeof parsed.name !== 'string' ||
        typeof parsed.mime !== 'string' ||
        typeof parsed.size !== 'number'
      ) {
        return null;
      }
      return { id: parsed.id, name: parsed.name, mime: parsed.mime, size: parsed.size };
    } catch {
      return null;
    }
  }

  // 메시지들의 attachments 실파일+메타를 삭제(never-throw, 개별 파일 실패는 로그 후 계속).
  // channelId를 받지 않으므로(인터페이스 고정) attachments/ 아래 모든 채널 디렉터리를 훑어
  // 일치하는 id만 지운다 — id가 randomUUID 기반이라 충돌 위험은 무시 가능한 수준.
  deleteFor(messages: ChatMessage[]): void {
    if (!Array.isArray(messages) || messages.length === 0) return;
    const ids = new Set<string>();
    for (const m of messages) {
      const atts = m?.attachments;
      if (!Array.isArray(atts)) continue;
      for (const a of atts) {
        // 리뷰 지적(T1): path()/meta()와 동일한 형식 가드 — 검증 없이 path.join(dir, id)로 넘기면
        // '..\\..\\x' 같은 위조 id가 attachments/ 밖으로 이탈할 수 있다. 형식 불일치는 조용히 skip
        // (never-throw 원칙 — 지울 대상을 특정 못 하면 안전하게 아무것도 안 지운다).
        if (a && isValidAttachmentId(a.id)) ids.add(a.id);
      }
    }
    if (ids.size === 0) return;

    let channelDirs: string[];
    try {
      channelDirs = fs
        .readdirSync(this.baseDir(), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return; // attachments/ 디렉터리 자체가 없음 = 지울 것 없음
    }

    for (const channelId of channelDirs) {
      const dir = path.join(this.baseDir(), channelId);
      for (const id of ids) {
        try {
          const fp = path.join(dir, id);
          if (fs.existsSync(fp)) fs.unlinkSync(fp);
        } catch (e) {
          console.warn(`[attachment-store] 첨부 파일 삭제 실패(무시하고 계속): ${String(e)}`);
        }
        try {
          const mp = path.join(dir, `${id}.json`);
          if (fs.existsSync(mp)) fs.unlinkSync(mp);
        } catch (e) {
          console.warn(`[attachment-store] 첨부 메타 삭제 실패(무시하고 계속): ${String(e)}`);
        }
      }
    }
  }
}
