import { Injectable } from '@nestjs/common';

// 키별 직렬화 락(설계 §10.3 "페이지 락"). 같은 key는 직전 작업이 끝난 뒤 실행되고,
// 다른 key는 서로 독립적으로 병렬 진행한다. 진짜 mutex가 아니라 Promise 체인이다.
@Injectable()
export class KeyedLock {
  private chains = new Map<string, Promise<unknown>>();

  // key에 대한 작업을 직렬 실행한다. fn의 성패와 무관하게 다음 작업이 이어진다.
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    // 체인 꼬리(성패 흡수)를 기록하고, 이 key의 마지막 작업이면 맵에서 정리한다.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return result;
  }
}
