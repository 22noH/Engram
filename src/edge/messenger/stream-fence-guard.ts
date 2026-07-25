// 스트리밍 펜스 가드 — 델타를 UI로 내보내기 전에 통과하는 "표시용" 필터(순수 함수·상태기계).
//
// 왜 필요한가: 두뇌는 되묻기(```ask_user)와 코드 제안(```engram:propose)을 응답 텍스트 안의 펜스 블록으로
// 실어 보낸다. 그 블록들은 확정 시점에 extractAskUser/extractPropose가 떼어내 카드·버튼으로 바뀌므로
// 화면에 원시 JSON이 보여선 안 되는데, 실시간 스트리밍은 확정 전 조각을 그대로 흘려서 잠깐 날것이 보였다.
//
// 규칙:
//  1) 특수 펜스(SPECIAL_INFOS)가 열리면 그 지점부터 보류 → 닫히면 블록 전체를 버리고 이후 텍스트를 계속 흘린다.
//  2) 일반 펜스(```ts, ```html, ```chart 등)는 그대로 흘린다 — HTML 인라인 미리보기가 이 경로를 쓴다.
//  3) 아직 특수/일반을 판정할 수 없는 꼬리(``` 만 온 상태, ```ask 까지만 온 상태)는 판정될 때까지 보류했다가
//     특수가 아님이 확정되는 즉시 방출한다(무한 보류 금지).
//
// 경계: 최종 'msg' 프레임이 항상 권위(확정 텍스트)다. 이 가드는 delta 표시에만 관여하며 저장·최종 텍스트에
// 영향을 주지 않는다 — 그래서 스트림이 특수 펜스 안에서 끝나면 보류분을 그냥 버려도 안전하다.
//
// 펜스 인식 범위는 추출기(ask-user-block.ts / code-chat.ts)와 같은 결로 맞춘다: 두 추출기의 정규식도
// 줄머리를 요구하지 않으므로 여기서도 요구하지 않는다(가드가 흘린 걸 추출기가 떼는 비대칭 방지).

export interface StreamFenceGuard {
  // 델타 조각을 넣고, 지금 화면에 흘려도 되는 텍스트를 돌려받는다(''이면 이번엔 보류만 했다는 뜻).
  push(text: string): string;
  // 스트림 종료 시 남은 보류분. 특수 펜스 안이었다면 버린다(''), 아니면 그대로 돌려준다.
  flush(): string;
}

const FENCE = '```';
// 화면에서 감춰야 하는 펜스의 info string. 추출기와 짝 — 여기 없는 info는 전부 일반 펜스로 흘린다.
const SPECIAL_INFOS = ['ask_user', 'engram:propose'];

// info string이 아직 특수 펜스가 될 여지가 있는가(더 기다려야 하는가).
// - 'ask' → 'ask_user'의 접두라 여지 있음
// - 'ask_user ' → 이미 특수와 일치하고 뒤는 공백뿐(펜스 규칙상 [ \t]* 허용) → 여지 있음
// - 'asm' → 어느 쪽도 아님 → 확정 탈락
function mayBecomeSpecial(info: string): boolean {
  return SPECIAL_INFOS.some((s) => s.startsWith(info) || (info.startsWith(s) && /^[ \t]*$/.test(info.slice(s.length))));
}

function isSpecial(info: string): boolean {
  return SPECIAL_INFOS.includes(info.replace(/[ \t\r]+$/, ''));
}

// 문자열 끝에 걸린 "펜스가 될 수도 있는" 백틱 꼬리 길이(0~2). '```'는 이미 fence로 잡히므로 최대 2.
function trailingBacktickRun(s: string): number {
  let n = 0;
  while (n < 2 && n < s.length && s[s.length - 1 - n] === '`') n++;
  return n;
}

export function createStreamFenceGuard(): StreamFenceGuard {
  // 'text'=평문 흘림 / 'maybe'=held가 '```'로 시작, info string 판정 대기 / 'suppress'=특수 블록 안(전부 버림)
  let mode: 'text' | 'maybe' | 'suppress' = 'text';
  let held = '';

  const step = (): string => {
    let out = '';
    for (;;) {
      if (mode === 'text') {
        const i = held.indexOf(FENCE);
        if (i >= 0) {
          out += held.slice(0, i);
          held = held.slice(i);
          mode = 'maybe';
          continue;
        }
        // 펜스는 없지만 끝에 걸친 백틱 꼬리는 다음 조각과 합쳐 '```'가 될 수 있으니 남긴다.
        const keep = trailingBacktickRun(held);
        out += keep ? held.slice(0, held.length - keep) : held;
        held = keep ? held.slice(held.length - keep) : '';
        return out;
      }
      if (mode === 'maybe') {
        const rest = held.slice(FENCE.length);
        const nl = rest.indexOf('\n');
        if (nl < 0) {
          // 아직 줄이 안 끝났다 — 특수가 될 여지가 남아 있으면 계속 보류, 탈락 확정이면 즉시 방출.
          if (mayBecomeSpecial(rest)) return out;
          out += held;
          held = '';
          mode = 'text';
          return out;
        }
        const info = rest.slice(0, nl);
        if (isSpecial(info)) {
          held = rest.slice(nl + 1); // 여는 펜스 줄은 버린다
          mode = 'suppress';
          continue;
        }
        out += held.slice(0, FENCE.length + nl + 1); // '```info\n'까지 확정 방출
        held = rest.slice(nl + 1);
        mode = 'text';
        continue;
      }
      // suppress: 닫는 펜스까지 통째로 버린다. 못 찾으면 다음 조각과 합쳐 '```'가 될 백틱 꼬리만 남긴다.
      const i = held.indexOf(FENCE);
      if (i >= 0) {
        held = held.slice(i + FENCE.length);
        mode = 'text';
        continue;
      }
      held = held.slice(held.length - trailingBacktickRun(held));
      return out;
    }
  };

  return {
    push(text: string): string {
      if (!text) return '';
      held += text;
      return step();
    },
    flush(): string {
      // 특수 블록 안(또는 특수일지도 모르는 미판정 꼬리)이면 버린다 — 확정 텍스트는 어차피 msg 프레임이 싣는다.
      const out = mode === 'text' ? held : '';
      held = '';
      mode = 'text';
      return out;
    },
  };
}
