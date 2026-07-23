import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import App from './App';

// App.clear-compact.test.tsx와 동일한 최소 모의 소켓(단일 연결).
class FakeWS {
  static last: FakeWS;
  static OPEN = 1;
  onopen: (() => void) | null = null; onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null; onerror: (() => void) | null = null;
  readyState = 1; sent: string[] = [];
  constructor() { FakeWS.last = this; }
  send(d: string) { this.sent.push(d); }
  close() {}
}
beforeEach(() => { localStorage.clear(); (globalThis as any).WebSocket = FakeWS as any; });
afterEach(() => { vi.restoreAllMocks(); });

async function openWithChannel() {
  render(<App />);
  act(() => { FakeWS.last.onopen!(); });
  act(() => {
    FakeWS.last.onmessage!({ data: JSON.stringify({ t: 'channels', list: [{ id: 'g1', name: 'general', respondMode: 'all', mode: 'chat' }] }) });
  });
  await waitFor(() => expect(screen.getByText('# general')).toBeInTheDocument());
  const ws = FakeWS.last;
  ws.sent = [];
  return ws;
}

function mockUpload(meta: { id: string; name: string; mime: string; size: number }) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(meta), { status: 200 }));
}
function mockUploadError() {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'nope' }), { status: 500 }));
}

// T4 리뷰 C2 — 두 채널을 만들어 전환 시나리오를 테스트한다.
async function openWithTwoChannels() {
  render(<App />);
  act(() => { FakeWS.last.onopen!(); });
  act(() => { FakeWS.last.onmessage!({ data: JSON.stringify({ t: 'channels', list: [
    { id: 'g1', name: 'general', respondMode: 'all', mode: 'chat' },
    { id: 'g2', name: 'random', respondMode: 'all', mode: 'chat' },
  ] }) }); });
  await waitFor(() => expect(screen.getByText('# random')).toBeInTheDocument());
  const ws = FakeWS.last;
  ws.sent = [];
  return ws;
}

it('붙여넣기(Ctrl+V 스크린샷)로 파일이 오면 칩이 뜨고 업로드 fetch가 올바른 URL·헤더로 나간다', async () => {
  const ws = await openWithChannel();
  const f = mockUpload({ id: 'att-1', name: 'shot.png', mime: 'image/png', size: 3 });
  const input = document.getElementById('input') as HTMLInputElement;
  const file = new File(['abc'], 'shot.png', { type: 'image/png' });

  fireEvent.paste(input, { clipboardData: { files: [file] } });

  await waitFor(() => expect(screen.getByText('shot.png')).toBeInTheDocument());
  expect(f).toHaveBeenCalledTimes(1);
  const [url, init] = f.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('http://127.0.0.1:47800/attachments/g1');
  expect(init.method).toBe('POST');
  const headers = init.headers as Record<string, string>;
  expect(headers['x-attachment-name']).toBe(encodeURIComponent('shot.png'));
  expect(headers['content-type']).toBe('image/png');
  expect(headers.authorization).toBeUndefined(); // 무인증 로컬 연결 — 헤더 생략

  await waitFor(() => expect(document.querySelector('.attachChip.uploading')).toBeNull()); // 업로드 완료 후 상태 반영
  expect(ws.sent.length).toBe(0); // 업로드는 http, ws 프레임은 아직 안 나감
});

it('X 클릭으로 칩을 제거한다', async () => {
  await openWithChannel();
  mockUpload({ id: 'att-1', name: 'a.txt', mime: 'text/plain', size: 1 });
  const input = document.getElementById('input') as HTMLInputElement;
  const file = new File(['a'], 'a.txt', { type: 'text/plain' });
  fireEvent.paste(input, { clipboardData: { files: [file] } });
  await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument());

  const x = document.querySelector('.pendingChips .attachChip .x') as HTMLElement;
  fireEvent.click(x);
  expect(screen.queryByText('a.txt')).not.toBeInTheDocument();
});

it('메시지당 5개 상한 초과분은 업로드하지 않고 안내를 보여준다', async () => {
  await openWithChannel();
  const f = mockUpload({ id: 'x', name: 'x', mime: 'text/plain', size: 1 });
  const input = document.getElementById('input') as HTMLInputElement;
  const files = Array.from({ length: 6 }, (_, i) => new File(['x'], `f${i}.txt`, { type: 'text/plain' }));

  fireEvent.paste(input, { clipboardData: { files } });

  await waitFor(() => expect(document.querySelectorAll('.pendingChips .attachChip').length).toBe(5));
  expect(f).toHaveBeenCalledTimes(5); // 6번째는 업로드 자체가 안 나감
  expect(screen.getByText(/최대 5개|up to 5 files/)).toBeInTheDocument();
});

it('20MB 초과 파일은 칩 단계에서 거절되고 안내가 뜬다(업로드 안 나감)', async () => {
  await openWithChannel();
  const f = mockUpload({ id: 'x', name: 'x', mime: 'text/plain', size: 1 });
  const input = document.getElementById('input') as HTMLInputElement;
  const big = new File([new Uint8Array(1)], 'big.bin', { type: 'application/octet-stream' });
  Object.defineProperty(big, 'size', { value: 20 * 1024 * 1024 + 1 });

  fireEvent.paste(input, { clipboardData: { files: [big] } });

  expect(f).not.toHaveBeenCalled();
  expect(screen.getByText(/20MB|over 20MB/)).toBeInTheDocument();
});

it('Send 시 send 프레임에 attachments ids가 실리고 칩이 비워진다', async () => {
  const ws = await openWithChannel();
  mockUpload({ id: 'att-9', name: 'note.txt', mime: 'text/plain', size: 4 });
  const input = document.getElementById('input') as HTMLInputElement;
  const file = new File(['note'], 'note.txt', { type: 'text/plain' });
  fireEvent.paste(input, { clipboardData: { files: [file] } });
  await waitFor(() => expect(screen.getByText('note.txt')).toBeInTheDocument());
  await waitFor(() => expect(document.querySelector('.attachChip.uploading')).toBeNull());

  fireEvent.change(input, { target: { value: 'hello' } });
  fireEvent.keyDown(input, { key: 'Enter' });

  await waitFor(() => {
    expect(ws.sent.some((s) => s.includes('"send"') && s.includes('"attachments":["att-9"]'))).toBe(true);
  });
  expect(screen.queryByText('note.txt')).not.toBeInTheDocument(); // 전송 후 칩 비움
});

it('첨부만 있고 텍스트가 없어도 전송된다(첨부만 전송 허용)', async () => {
  const ws = await openWithChannel();
  mockUpload({ id: 'att-only', name: 'img.png', mime: 'image/png', size: 5 });
  const input = document.getElementById('input') as HTMLInputElement;
  const file = new File(['x'], 'img.png', { type: 'image/png' });
  fireEvent.paste(input, { clipboardData: { files: [file] } });
  await waitFor(() => expect(document.querySelector('.attachChip.uploading')).toBeNull());

  fireEvent.keyDown(input, { key: 'Enter' }); // 입력값은 빈 문자열 그대로

  await waitFor(() => {
    expect(ws.sent.some((s) => s.includes('"send"') && s.includes('"channelId":"g1"') && s.includes('"attachments":["att-only"]'))).toBe(true);
  });
});

it('첨부 없는 일반 전송은 attachments 키가 아예 안 실린다(회귀 0)', async () => {
  const ws = await openWithChannel();
  const input = document.getElementById('input') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'plain text' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(ws.sent.some((s) => s.includes('"send"'))).toBe(true));
  const frame = ws.sent.find((s) => s.includes('"send"'))!;
  expect(frame).not.toContain('attachments');
});

// T4 리뷰 C2 — 첨부 시점 바인딩(connId+channelId)과 전송 시점 바인딩이 어긋나면 안 된다.
it('채널을 바꾸면 전송 전 칩이 비워지고 안내가 뜬다(바인딩 불일치 방지)', async () => {
  await openWithTwoChannels();
  mockUpload({ id: 'att-c2', name: 'doc.txt', mime: 'text/plain', size: 3 });
  const input = document.getElementById('input') as HTMLInputElement;
  const file = new File(['x'], 'doc.txt', { type: 'text/plain' });
  fireEvent.paste(input, { clipboardData: { files: [file] } });
  await waitFor(() => expect(screen.getByText('doc.txt')).toBeInTheDocument());

  fireEvent.click(screen.getByText('# random')); // 다른 실채널id로 전환

  await waitFor(() => expect(screen.queryByText('doc.txt')).not.toBeInTheDocument());
  expect(screen.getByText(/채널이 바뀌어|channel changed/)).toBeInTheDocument();
});

it('바인딩이 어긋난 첨부 id는 send 프레임에 실리지 않는다(벨트)', async () => {
  const ws = await openWithTwoChannels();
  mockUpload({ id: 'att-c2b', name: 'doc2.txt', mime: 'text/plain', size: 3 });
  const input = document.getElementById('input') as HTMLInputElement;
  const file = new File(['x'], 'doc2.txt', { type: 'text/plain' });
  fireEvent.paste(input, { clipboardData: { files: [file] } });
  await waitFor(() => expect(screen.getByText('doc2.txt')).toBeInTheDocument());
  await waitFor(() => expect(document.querySelector('.attachChip.uploading')).toBeNull());

  fireEvent.click(screen.getByText('# random'));
  await waitFor(() => expect(screen.queryByText('doc2.txt')).not.toBeInTheDocument());

  fireEvent.change(input, { target: { value: 'hi in random' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(ws.sent.some((s) => s.includes('"send"') && s.includes('"channelId":"g2"'))).toBe(true));
  const frame = ws.sent.find((s) => s.includes('"channelId":"g2"'))!;
  expect(frame).not.toContain('att-c2b'); // 옛 채널 바인딩의 id는 절대 안 실림
});

// T4 리뷰 I4 — 실패 칩이 남아있는 동안 Send를 막는다(조용히 빼고 보내면 첨부됐다고 착각한다).
it('업로드 실패 칩이 있으면 Send가 비활성화되고, 제거하면 다시 활성화된다', async () => {
  await openWithChannel();
  mockUploadError();
  const input = document.getElementById('input') as HTMLInputElement;
  const file = new File(['x'], 'bad.txt', { type: 'text/plain' });
  fireEvent.paste(input, { clipboardData: { files: [file] } });
  await waitFor(() => expect(document.querySelector('.attachChip.error')).toBeInTheDocument());

  const sendBtn = document.querySelector('#inputbar > button:not(.attachBtn)') as HTMLButtonElement;
  fireEvent.change(input, { target: { value: 'hello' } }); // 텍스트가 있어도 실패 칩이면 막힘
  expect(sendBtn.disabled).toBe(true);
  expect(screen.getByText(/제거하거나 다시 시도|remove it or retry/)).toBeInTheDocument();

  const x = document.querySelector('.pendingChips .attachChip .x') as HTMLElement;
  fireEvent.click(x);
  expect(sendBtn.disabled).toBe(false);
});
