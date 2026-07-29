import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// 낡은 플러그인 알림(2026-07-27).
//
// 실사고: 사용자의 Claude Code 플러그인이 0.0.7에 3일 넘게 멈춰 있었다. 플러그인 업데이트는 GitHub이
// 아니라 **로컬 마켓플레이스 클론**을 기준으로 판단하는데 그 클론이 갱신되지 않았고, 서드파티
// 마켓플레이스는 `autoUpdate`가 기본으로 켜지지 않는다(이 머신의 다른 마켓플레이스 5개 전부
// 필드 자체가 없고 몇 달째 그대로였다). 즉 **설치한 사람은 설치 시점 버전에 영원히 머문다.**
//
// 다행히 MCP 서버 자체는 `npx -y`라 스폰마다 최신을 받는다 — 얼어붙는 건 슬래시 명령이다.
// 그래서 최신인 우리가 낡은 플러그인을 알아채고 알려줄 수 있다.
//
// ponytail: `~/.claude/plugins/installed_plugins.json` 경로에 의존한다. 못 읽거나 형식이 다르면
// 조용히 아무 말도 하지 않는다(오탐으로 겁주지 않는다). 경로가 바뀌면 알림이 사라질 뿐 기능은 멀쩡하다.

/** 우리(npm 패키지)의 버전. 못 찾으면 null — 알림 자체를 포기한다. */
export function ownVersion(fromDir: string = __dirname): string | null {
  let dir = fromDir;
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'engram-wiki-mcp' && typeof pkg.version === 'string') return pkg.version;
    } catch {
      /* 이 층엔 없다 — 위로 */
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** 설치된 engram 플러그인 버전. 없거나 못 읽으면 null. */
export function installedPluginVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  if (!home) return null;
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'),
    ) as { plugins?: Record<string, Array<{ version?: unknown }>> };
    const plugins = raw.plugins ?? {};
    for (const [key, entries] of Object.entries(plugins)) {
      if (!key.startsWith('engram@')) continue;
      for (const e of entries ?? []) {
        if (typeof e?.version === 'string' && e.version !== 'unknown') return e.version;
      }
    }
  } catch {
    /* 파일 없음·형식 다름 — 조용히 포기 */
  }
  return null;
}

/** a < b면 음수. 숫자 세 자리(x.y.z)만 본다 — 못 읽는 형태면 null(비교 포기). */
function compare(a: string, b: string): number | null {
  const parse = (v: string): number[] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * 설치된 플러그인이 우리보다 낡았으면 안내문, 아니면 null.
 * 모르는 건 말하지 않는다 — 버전을 못 읽거나 비교가 안 되면 조용히 null.
 */
export function stalePluginNotice(env: NodeJS.ProcessEnv = process.env, fromDir?: string): string | null {
  const ours = ownVersion(fromDir);
  const installed = installedPluginVersion(env);
  if (!ours || !installed) return null;
  const cmp = compare(installed, ours);
  if (cmp === null || cmp >= 0) return null;
  return (
    `NOTE: the Engram Claude Code plugin installed here is ${installed}, but this server is ${ours}. ` +
    `The wiki tools are current either way, but the /engram: slash commands are frozen at ${installed} — ` +
    `newer ones will not appear. Plugin updates are read from a local marketplace clone that does not refresh ` +
    `on its own unless auto-update is enabled, so tell the user to run:\n` +
    `  claude plugin marketplace update engram\n` +
    `  claude plugin update engram@engram\n` +
    `then restart Claude Code. Mention this once, when it is relevant — do not repeat it every turn.`
  );
}
