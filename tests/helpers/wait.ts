import { telemetry } from '../../src/core/telemetry.js';
import type { TelemetryEvent, TelemetryPayload } from '../../src/types.js';

export interface WaitOptions {
  timeout?: number;
  interval?: number;
  describe?: string;
}

/**
 * Polls until `predicate` returns something truthy.
 *
 * Tests that instead sleep for a fixed duration are betting that the work
 * finishes inside a window they guessed. That bet fails intermittently on a
 * loaded machine, and it makes every run pay the full duration even when the
 * work took 20ms. Waiting on the actual condition is both faster and stable.
 */
export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  { timeout = 10000, interval = 10, describe = 'condition' }: WaitOptions = {}
): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: T | undefined;

  for (;;) {
    last = await predicate();
    if (last) return last;

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeout}ms waiting for ${describe} (last value: ${JSON.stringify(last)})`
      );
    }

    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

/** Resolves once a telemetry event fires, or rejects on timeout. */
export function waitForEvent(
  event: TelemetryEvent,
  { timeout = 10000 }: { timeout?: number } = {}
): Promise<TelemetryPayload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out after ${timeout}ms waiting for "${event}"`));
    }, timeout);

    const unsubscribe = telemetry.on(event, payload => {
      clearTimeout(timer);
      unsubscribe();
      resolve(payload);
    });
  });
}

/**
 * Asserts something stays false for a window. Only for genuinely negative
 * assertions ("this must NOT happen"), where there is no event to wait on.
 */
export async function stayFalse(
  predicate: () => boolean | Promise<boolean>,
  { duration = 300, interval = 25 }: { duration?: number; interval?: number } = {}
): Promise<void> {
  const deadline = Date.now() + duration;
  while (Date.now() < deadline) {
    if (await predicate()) {
      throw new Error('Condition became true when it should not have');
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}
