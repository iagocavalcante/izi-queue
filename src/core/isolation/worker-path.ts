import { fileURLToPath } from 'url';
import { dirname } from 'path';

/**
 * Directory holding the compiled isolation modules, and therefore the worker
 * thread entry point.
 *
 * `import.meta.url` has to appear literally: it is the only way an ES module
 * can learn its own location, and there is no runtime substitute. `require`
 * does not exist in the published package (it is ESM-only), and a direct
 * `eval` does not help either -- eval code is parsed as a script, where
 * `import.meta` is a syntax error regardless of the enclosing module.
 *
 * That makes this file unloadable under the CommonJS test runner, so Jest maps
 * it to a stand-in (see `moduleNameMapper`). The real implementation is
 * exercised where it matters: the CI job that installs the packed tarball into
 * an ESM project and runs an isolated job through it.
 */
export function isolationDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}
