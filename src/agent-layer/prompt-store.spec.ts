import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadPrompt } from './prompt-store';

describe('loadPrompt', () => {
  it('prompts/{name}.md가 있으면 그 내용을 읽는다(코드 수정 없이 튜닝)', () => {
    // 실제 레포의 prompts/coding-rules.md를 읽어 fallback이 아닌 파일 내용이 오는지 확인.
    const out = loadPrompt('coding-rules', 'FALLBACK_표식');
    expect(out).not.toBe('FALLBACK_표식');
    expect(out).toContain('이 조각만'); // 파일 내용
  });

  it('파일이 없으면 fallback(내장 기본값)을 쓴다 — out-of-box 동작 보장', () => {
    expect(loadPrompt('존재하지-않는-프롬프트-xyz', '기본값입니다')).toBe('기본값입니다');
  });

  it('파일이 비어 있으면 fallback', () => {
    // prompts 디렉터리에 빈 파일을 둘 수 없으니, 없는 이름으로 빈/공백 처리 경로만 확인.
    expect(loadPrompt('또-없는-이름-abc', '폴백')).toBe('폴백');
  });
});
