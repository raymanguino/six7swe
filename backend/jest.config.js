// Every package.json test script runs Jest through the `jest` script, which
// starts it with `node --experimental-vm-modules`.
// Some dependencies (jose 6) are ESM-only, and Jest only loads them through
// require(esm) on Node 24.9+ when VM modules are enabled; without the flag the
// suites that import them fail with "Must use import to load ES Module".
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  // Each worker compiles TypeScript on its own, which is memory hungry. The
  // default (one worker per CPU) exhausts RAM on a laptop and the workers
  // crash with "ran out of memory". Keep the count low and predictable.
  maxWorkers: 2,
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
};