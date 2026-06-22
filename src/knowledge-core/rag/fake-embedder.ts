import { Injectable } from '@nestjs/common';
import { IEmbedder } from './embedder.port';

// 결정론적 가짜 임베더. 네트워크·모델 다운로드 없이 단위테스트에 쓴다.
// 문자 코드로 버킷을 채운 뒤 L2 정규화 — 실제 임베더(normalize:true)의 단위벡터를 모방.
@Injectable()
export class FakeEmbedder implements IEmbedder {
  readonly dimensions = 64;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vectorize(t));
  }

  private vectorize(text: string): number[] {
    const v = new Array(this.dimensions).fill(0);
    for (let i = 0; i < text.length; i++) {
      v[text.charCodeAt(i) % this.dimensions] += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}
