// 두뇌 기반 본문 병합기 팩토리(15c). WikiGit.setBodyMerger에 주입.
// 두뇌 모듈에 직접 의존하지 않게 구조적 타입만 받는다.
interface BrainLike {
  complete(prompt: string): Promise<{ text: string; isError: boolean }>;
}

export function makeBrainBodyMerger(
  brain: BrainLike,
  promptTemplate: string,
): (oursBody: string, theirsBody: string) => Promise<string | null> {
  return async (oursBody, theirsBody) => {
    const prompt = promptTemplate.replace('{{OURS}}', oursBody).replace('{{THEIRS}}', theirsBody);
    const r = await brain.complete(prompt);
    const t = r.isError ? '' : r.text.trim();
    return t ? t : null; // 실패/빈 출력 → null → 호출자가 union 폴백
  };
}
