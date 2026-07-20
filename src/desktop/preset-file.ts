import * as fs from 'fs';
import * as path from 'path';
import { loadAuthSettings } from '../edge/auth/auth.config';

// 클라이언트 배포 프리셋(configDir/preset.json — `{name,endpoint}`). desktop/main.ts가 부팅 시
// 이 파일이 있으면 렌더러 URL에 presetName/presetEndpoint로 주입해 connections.ts seed()가 그
// 서버를 기본 연결로 시드한다(Phase 16a Task 15 관성). 서버 콘솔 S3 Task 2에서 이 셰이프를
// 순수 함수로 뽑아 main.ts 호출부(읽기)와 admin-http(쓰기용 생성)가 같은 계약을 공유하게 한다.
export interface PresetInfo { name: string; endpoint: string }

// 기존 desktop/main.ts 인라인 로직(JSON.parse + 기본 이름 채움)을 그대로 옮긴 순수 헬퍼 —
// 동작 무변경(존재하지 않거나 깨짐/endpoint 없음 → null, main.ts는 null이면 프리셋 없음으로 처리).
export function readPresetFile(configDir: string): PresetInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'preset.json'), 'utf8')) as { name?: string; endpoint?: string };
    if (!raw.endpoint) return null;
    return { name: raw.name || 'Server', endpoint: raw.endpoint };
  } catch {
    return null;
  }
}

export function writePresetFile(configDir: string, preset: PresetInfo): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'preset.json'), JSON.stringify(preset, null, 2));
}

// 서버 자신의 배포 프리셋 생성(admin-http GET /admin/api/preset 전용 — 서버 콘솔 S3 Task 2).
// name은 auth.json의 serverName(없으면 'Engram Server'). endpoint는 ws://host:port
// (renderer/src/config.ts httpBase()가 ws:→http: 치환하는 계약과 동일한 스킴).
// bind가 0.0.0.0(LAN/인터넷 공개)이면 서버 프로세스 자신은 스스로의 외부 IP를 알 수 없어
// (멀티 NIC·NAT 등) hostHint(호출부가 요청 Host 헤더에서 뽑아 넘기는 호스트명)를 우선 쓰고,
// 그마저 없으면 플레이스홀더를 남겨 콘솔/사용자가 직접 채우도록 안내한다.
export function buildPreset(configDir: string, serverInfo: { bind: string; port: number; hostHint?: string }): PresetInfo {
  const auth = loadAuthSettings(configDir);
  const name = auth.serverName || 'Engram Server';
  const host = serverInfo.bind === '0.0.0.0'
    ? ((serverInfo.hostHint && serverInfo.hostHint.trim()) || 'YOUR-SERVER-IP')
    : serverInfo.bind;
  return { name, endpoint: `ws://${host}:${serverInfo.port}` };
}
