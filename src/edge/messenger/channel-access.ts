import type { ChatChannel } from './chat-store';
import type { GroupStore } from '../auth/group-store';
import { groupChannelIdsFor } from '../auth/effective-access';

// 채널 접근 판정(계정 기준) — self.adapter의 ws canAccessChannel과 attachments-http(HTTP 게이트)가
// 공유하는 단일 소스(Task 2 브리프: "로직 추출·재사용, 중복 구현 금지"). 무인증/free 소켓(bypass) 판정은
// 호출부 몫(ws=소켓 캐시된 remoteAddr, http=요청별 isLoopback — 판정 방식이 달라 여기서 겸하지 않는다).
// 여기는 "계정이 있고 게이트가 살아있을 때" 공개/비공개+creatorId/memberIds/그룹 규칙만 담당한다.
//
// 공개 채널=전원. 비공개 채널=계정 없음→거부, creatorId 본인 또는 memberIds 포함 또는 그 채널을
// 접근 목록에 넣은 그룹의 멤버(groupChannelIdsFor, 더하기)면 허용. groups 미주입이면 그룹 규칙은
// 공집합(groupChannelIdsFor(.., [])=[])이라 개인 판정만 남는다.
export function accountCanAccessChannel(
  accountId: string | undefined,
  ch: ChatChannel,
  groups: GroupStore | undefined,
): boolean {
  if ((ch.visibility ?? 'public') !== 'private') return true;
  if (!accountId) return false;
  if (ch.creatorId === accountId || (ch.memberIds ?? []).includes(accountId)) return true;
  const list = groups?.list() ?? [];
  return groupChannelIdsFor(accountId, list).includes(ch.id);
}
