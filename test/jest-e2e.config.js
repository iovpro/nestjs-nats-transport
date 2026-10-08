/** @type {import('jest').Config} */
module.exports = {
  rootDir: '..',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.e2e-spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/\\.build/'],
  modulePathIgnorePatterns: ['<rootDir>/test/\\.build/'],
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/test/tsconfig.json' }],
  },
  globalSetup: '<rootDir>/test/setup/global-setup.ts',
  testTimeout: 60_000,
  maxWorkers: 1,
  verbose: true,
};
