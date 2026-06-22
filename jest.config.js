/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  // ENGRAM_RAG_INTEGRATION=1 일 때 통합테스트 환경을 위한 커스텀 testEnvironment.
  // --experimental-vm-modules 모드에서 onnxruntime-node의 TypedArray realm 충돌을 패치한다.
  testEnvironment:
    process.env.ENGRAM_RAG_INTEGRATION === '1'
      ? '<rootDir>/../jest-integration-env.js'
      : 'node',
  // ENGRAM_RAG_INTEGRATION=1 일 때만 onnxruntime-node 세션이 열린 채로 남아 Jest가 종료를 기다리는 현상을 방지한다.
  forceExit: process.env.ENGRAM_RAG_INTEGRATION === '1',
};
