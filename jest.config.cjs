/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    // worker-path reads import.meta.url, which cannot be parsed as CommonJS.
    // The real module is covered by the CI job that runs an isolated job from
    // the packed tarball in an ESM project.
    '^(.*/)?worker-path\\.js$': '<rootDir>/tests/helpers/worker-path-cjs.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'node',
          esModuleInterop: true,
        },
      },
    ],
  },
  testMatch: ['**/tests/**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  testTimeout: 10000,
  silent: true, // Suppress migration logs during tests
};
