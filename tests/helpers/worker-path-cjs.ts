import { join } from 'path';

/**
 * CommonJS stand-in for `src/core/isolation/worker-path.ts`, which cannot load
 * under the CommonJS test runner because it reads `import.meta.url`.
 *
 * The compiled worker thread only exists under `dist`, which `pretest`
 * guarantees is built and current.
 */
export function isolationDir(): string {
  return join(process.cwd(), 'dist', 'core', 'isolation');
}
