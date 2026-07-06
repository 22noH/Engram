import { ko } from './config';

export const T = {
  placeholder: ko ? '메시지 입력…' : 'Message…',
  send: ko ? '보내기' : 'Send',
  newChannel: ko ? '+ 새 채널' : '+ New channel',
  newChannelPrompt: ko ? '채널 이름:' : 'Channel name:',
  replies: (n: number) => (ko ? `답글 ${n}개` : `${n} replies`),
  replyPh: ko ? '스레드에 답장…' : 'Reply in thread…',
  delConfirm: (name: string) => (ko ? `'${name}' 채널을 삭제할까요? (기록 파일은 남습니다)` : `Delete channel '${name}'? (history file is kept)`),
  delChannel: ko ? '채널 삭제' : 'Delete channel',
  modeAll: ko ? '모든 메시지에 반응' : 'Respond to all',
  modeMention: ko ? '@Engram 멘션에만 반응' : 'Respond to @Engram only',
  engram: 'Engram', me: ko ? '나' : 'me',
  thinking: ko ? 'Engram이 생각하는 중' : 'Engram is thinking',
  tabChat: ko ? '채팅' : 'Chat',
  tabCode: ko ? '코드' : 'Code',
  pickFolder: ko ? '먼저 작업할 폴더를 선택하세요 📁' : 'First choose a folder to work in 📁',
  pickFolderBtn: ko ? '폴더 선택' : 'Choose folder',
  pickFolderPath: ko ? '폴더 경로 입력…' : 'Folder path…',
  newCodeChannelPrompt: ko ? '코드 채널 이름:' : 'Code channel name:',
};
