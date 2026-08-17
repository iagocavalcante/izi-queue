import type { Logger } from '../types.js';

/**
 * Default `Logger`, used everywhere a `logger` is not supplied. Preserves
 * izi-queue's pre-#40 behavior of writing everything to the console: `debug`
 * and `info` go to `console.debug`/`console.log`, `warn`/`error` to their
 * matching console methods. Every message is prefixed with `[izi-queue]`,
 * matching the old hardcoded `console.*` call sites.
 *
 * This is the one sanctioned place in `src/` allowed to call `console.*`
 * directly -- see the `no-console` override for this file in
 * `eslint.config.js`.
 */
export const consoleLogger: Logger = {
  debug(message, meta) {
    if (meta !== undefined) {
      console.debug(`[izi-queue] ${message}`, meta);
    } else {
      console.debug(`[izi-queue] ${message}`);
    }
  },
  info(message, meta) {
    if (meta !== undefined) {
      console.log(`[izi-queue] ${message}`, meta);
    } else {
      console.log(`[izi-queue] ${message}`);
    }
  },
  warn(message, meta) {
    if (meta !== undefined) {
      console.warn(`[izi-queue] ${message}`, meta);
    } else {
      console.warn(`[izi-queue] ${message}`);
    }
  },
  error(message, meta) {
    if (meta !== undefined) {
      console.error(`[izi-queue] ${message}`, meta);
    } else {
      console.error(`[izi-queue] ${message}`);
    }
  }
};
