import { useEffect, useState } from 'react';
import { T, ko } from '../i18n';
import {
  fetchServerStatus, fetchSchedules, deleteSchedule, fetchLogs, fetchMembers,
  type StatusData, type ScheduleDto, type MemberDto,
} from '../api';
import { Nav, type NavKey } from '../components/Nav';

// ⑩ 상태·로그 — 목업 픽셀 그대로. 통계 타일 4개(가동 시간·마지막 생존 신호·대화 기록 용량·
// 위키+지식 용량) + 예약 작업 목록(삭제 가능) + 최근 로그(monospace 블록).
//
// ★뺀 것(브리프 결정): 예약 작업 행의 "seojun이 등록" 부분. ScheduleEntry(admin-http.ts
// getSchedules 계약 — schedules-file.ts listSchedules)에는 등록자 필드 자체가 없다 — 없는 데이터를
// 지어내지 않고 각 행을 "task 이름(제목) + 사람이 읽는 cron · # channelId(부제)"로만 그린다.
//
// ★cron 표시: 서버가 원문 크론 표현식(예: "0 9 * * *")을 그대로 내려준다(schedules-file.ts —
// desktop/settings.html도 이 표현식을 그대로 mono 텍스트로 보여주는 게 기존 관례). 이 화면은
// 목업이 보여준 두 가지 흔한 패턴(매일 HH:MM·매주 요일 HH:MM)만 humanizeCron()으로 사람이 읽는
// 문구로 바꾼다 — 전체 크론 문법(범위·리스트·step 등)을 파싱하는 일반 변환기는 이 화면 범위 밖이라
// 인식하지 못하는 패턴은 원문 크론을 그대로 보여준다(report 참조).
const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];
const DOW_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad2 = (n: number) => String(n).padStart(2, '0');

export function humanizeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts;
  const m = Number(min);
  const h = Number(hour);
  if (!Number.isInteger(m) || !Number.isInteger(h) || m < 0 || m > 59 || h < 0 || h > 23) return cron;
  const time = `${pad2(h)}:${pad2(m)}`;
  if (dom === '*' && mon === '*' && dow === '*') return ko ? `매일 ${time}` : `Daily ${time}`;
  if (dom === '*' && mon === '*' && /^[0-6]$/.test(dow)) {
    const d = Number(dow);
    return ko ? `매주 ${DOW_KO[d]} ${time}` : `Weekly ${DOW_EN[d]} ${time}`;
  }
  return cron;
}

function formatUptime(sec: number): string {
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  return ko ? `${days}일 ${hours}시간` : `${days}d ${hours}h`;
}

function formatHeartbeat(ms: number | null): { text: string; ok: boolean } {
  if (ms === null) return { text: T.heartbeatNever, ok: false };
  const diffMin = Math.floor((Date.now() - ms) / 60000);
  if (diffMin < 1) return { text: T.heartbeatJustNow, ok: true };
  return { text: T.heartbeatMinutesAgo(diffMin), ok: false };
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
function formatBytes(bytes: number): string {
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) { v /= 1024; i++; }
  const rounded = i === 0 || v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${rounded} ${BYTE_UNITS[i]}`;
}

export function StatusLog({ serverName, role, active, onNavigate }: {
  serverName: string; role: string; active: NavKey; onNavigate: (k: NavKey) => void;
}) {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [schedules, setSchedules] = useState<ScheduleDto[] | null>(null);
  const [logs, setLogs] = useState<string[] | null>(null);
  const [members, setMembers] = useState<MemberDto[] | null>(null);

  const load = () => {
    fetchServerStatus().then(setStatus);
    fetchSchedules().then(setSchedules);
    fetchLogs().then(setLogs);
    fetchMembers().then(setMembers);
  };
  useEffect(load, []);

  const removeSchedule = async (id: string) => {
    await deleteSchedule(id);
    load();
  };

  const pendingMembers = (members ?? []).filter((m) => m.status === 'pending').length;
  const heartbeat = formatHeartbeat(status?.lastHeartbeatMs ?? null);

  return (
    <div className="page">
      <div className="frame">
        <Nav serverName={serverName} address={window.location.host} active={active} onNavigate={onNavigate}
             pendingMembers={pendingMembers} role={role} />
        <div className="main">
          <h2>{T.statusLogTitle}</h2>
          <div className="sub">{T.statusLogSub}</div>

          <div className="statgrid">
            <div className="grp" style={{ padding: '12px 14px' }}>
              <div style={{ fontSize: 11.5, color: 'var(--dim)', fontWeight: 600 }}>{T.statUptime}</div>
              <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4 }}>{formatUptime(status?.uptimeSec ?? 0)}</div>
            </div>
            <div className="grp" style={{ padding: '12px 14px' }}>
              <div style={{ fontSize: 11.5, color: 'var(--dim)', fontWeight: 600 }}>{T.statLastHeartbeat}</div>
              <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4, color: heartbeat.ok ? 'var(--ok)' : undefined }}>
                {heartbeat.text}
              </div>
            </div>
            <div className="grp" style={{ padding: '12px 14px' }}>
              <div style={{ fontSize: 11.5, color: 'var(--dim)', fontWeight: 600 }}>{T.statChatBytes}</div>
              <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4 }}>{formatBytes(status?.chatBytes ?? 0)}</div>
            </div>
            <div className="grp" style={{ padding: '12px 14px' }}>
              <div style={{ fontSize: 11.5, color: 'var(--dim)', fontWeight: 600 }}>{T.statKnowledgeBytes}</div>
              <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4 }}>{formatBytes(status?.knowledgeBytes ?? 0)}</div>
            </div>
          </div>

          <div className="grp-h">{T.schedulesHeading((schedules ?? []).length)}</div>
          <div className="grp">
            {(schedules ?? []).map((s) => (
              <div className="row" key={s.id}>
                <div className="who">
                  <div className="n">{s.task}</div>
                  <div className="id" style={{ fontFamily: 'inherit' }}>{humanizeCron(s.cron)} · # {s.channelId}</div>
                </div>
                <div className="btns">
                  <button className="danger" onClick={() => removeSchedule(s.id)}>{T.deleteBtn}</button>
                </div>
              </div>
            ))}
          </div>

          <div className="grp-h">{T.recentLogsHeading}</div>
          <div className="grp" style={{
            padding: '12px 14px', fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--dim)',
            lineHeight: 1.7, whiteSpace: 'pre-wrap',
          }}>
            {(logs ?? []).map((line, i) => <div key={i}>{line}</div>)}
          </div>
        </div>
      </div>
    </div>
  );
}
