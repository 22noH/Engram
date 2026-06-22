/**
 * 통합테스트 전용 Jest 환경.
 * --experimental-vm-modules 모드에서 onnxruntime-node 네이티브 애드온이
 * 주 realm의 TypedArray를 기대하므로, VM context에도 주 realm 것을 노출한다.
 */
const { TestEnvironment } = require('jest-environment-node');

class IntegrationEnvironment extends TestEnvironment {
  async setup() {
    await super.setup();
    // onnxruntime-node가 instanceof Float32Array 등을 검사할 때 주 realm 것을 사용하게 한다.
    const typedArrayCtors = [
      'Float32Array', 'Float64Array', 'Int8Array', 'Int16Array', 'Int32Array',
      'Uint8Array', 'Uint16Array', 'Uint32Array', 'BigInt64Array', 'BigUint64Array',
    ];
    for (const name of typedArrayCtors) {
      this.global[name] = global[name];
    }
    this.global.ArrayBuffer = global.ArrayBuffer;
    this.global.SharedArrayBuffer = global.SharedArrayBuffer;
    this.global.Buffer = global.Buffer;
  }
}

module.exports = IntegrationEnvironment;
