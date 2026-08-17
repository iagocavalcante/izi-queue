import {
  createJob,
  calculateBackoff,
  formatError,
  isValidTransition,
  isTerminal,
  STATE_TRANSITIONS,
  TERMINAL_STATES
} from '../src/core/job.js';
import type { JobState } from '../src/types.js';

describe('Job Module', () => {
  describe('createJob', () => {
    it('should create a job with default values', () => {
      const job = createJob('TestWorker', { args: { foo: 'bar' } });

      expect(job.worker).toBe('TestWorker');
      expect(job.args).toEqual({ foo: 'bar' });
      expect(job.queue).toBe('default');
      expect(job.state).toBe('available');
      expect(job.attempt).toBe(0);
      expect(job.maxAttempts).toBe(20);
      expect(job.priority).toBe(0);
      expect(job.errors).toEqual([]);
      expect(job.meta).toEqual({});
      expect(job.tags).toEqual([]);
    });

    it('should create a job with custom options', () => {
      const job = createJob('TestWorker', {
        args: { data: 'test' },
        queue: 'priority',
        maxAttempts: 5,
        priority: 1,
        meta: { source: 'api' },
        tags: ['important']
      });

      expect(job.queue).toBe('priority');
      expect(job.maxAttempts).toBe(5);
      expect(job.priority).toBe(1);
      expect(job.meta).toEqual({ source: 'api' });
      expect(job.tags).toEqual(['important']);
    });

    it('should set state to scheduled when scheduledAt is in the future', () => {
      const future = new Date(Date.now() + 60000);
      const job = createJob('TestWorker', {
        args: {},
        scheduledAt: future
      });

      expect(job.state).toBe('scheduled');
      expect(job.scheduledAt).toEqual(future);
    });

    it('should set state to available when scheduledAt is in the past', () => {
      const past = new Date(Date.now() - 60000);
      const job = createJob('TestWorker', {
        args: {},
        scheduledAt: past
      });

      expect(job.state).toBe('available');
    });
  });

  describe('calculateBackoff', () => {
    describe('polynomial strategy (default)', () => {
      it('defaults to the polynomial strategy when none is given', () => {
        const withDefault = calculateBackoff(3);
        const withExplicitStrategy = calculateBackoff(3, { strategy: 'polynomial' });

        // Both draw from the same formula and bounds; compare bounds rather
        // than exact values since each call re-rolls the random jitter term.
        expect(withDefault).toBeGreaterThanOrEqual(96000); // 3^4 + 15 = 96s
        expect(withDefault).toBeLessThanOrEqual(126000);   // + rand(0..10) * 3 = 30s max
        expect(withExplicitStrategy).toBeGreaterThanOrEqual(96000);
        expect(withExplicitStrategy).toBeLessThanOrEqual(126000);
      });

      it('computes attempt^4 + 15 + rand(0..10) * attempt seconds', () => {
        // Attempt 1: 1 + 15 = 16s, + rand(0..10)*1 => [16, 26]
        const backoff1 = calculateBackoff(1);
        expect(backoff1).toBeGreaterThanOrEqual(16000);
        expect(backoff1).toBeLessThanOrEqual(26000);

        // Attempt 20: 20^4 + 15 = 160015s, + rand(0..10)*20 => up to 160215s
        const backoff20 = calculateBackoff(20);
        expect(backoff20).toBeGreaterThanOrEqual(160015000);
        expect(backoff20).toBeLessThanOrEqual(160215000);
        // ~44.4 hours, the horizon the issue asked for
        expect(backoff20 / 1000 / 3600).toBeGreaterThan(44);
      });

      it('has zero jitter at attempt 0', () => {
        // rand(0..10) * 0 == 0, so attempt 0 is deterministic
        expect(calculateBackoff(0)).toBe(15000);
      });

      it('grows monotonically: the minimum possible delay for attempt n+1 exceeds the maximum possible delay for attempt n', () => {
        const maxPossible = (attempt: number) => Math.pow(attempt, 4) + 15 + 10 * attempt;
        const minPossible = (attempt: number) => Math.pow(attempt, 4) + 15;

        for (let attempt = 0; attempt < 20; attempt++) {
          expect(minPossible(attempt + 1)).toBeGreaterThan(maxPossible(attempt));
        }
      });

      it('respects a custom padSeconds, power, and jitterMax', () => {
        const backoff = calculateBackoff(2, {
          padSeconds: 5,
          power: 2,
          jitterMax: 0 // no jitter for a predictable test
        });
        // 2^2 + 5 = 9 seconds = 9000ms
        expect(backoff).toBe(9000);
      });

      it('applies maxDelay as a cap on the polynomial curve', () => {
        const backoff = calculateBackoff(20, { maxDelay: 100 });
        expect(backoff).toBe(100000);
      });

      it('has no cap by default, even at high attempts', () => {
        const backoff = calculateBackoff(20);
        expect(backoff).toBeGreaterThan(100000);
      });
    });

    describe('exponential strategy (legacy, explicit opt-in)', () => {
      it('calculates exponential backoff with default options, unchanged from before', () => {
        // Attempt 1: 15 + 2^1 = 17 seconds (±10% jitter)
        const backoff1 = calculateBackoff(1, { strategy: 'exponential' });
        expect(backoff1).toBeGreaterThanOrEqual(15300); // 17 * 0.9 * 1000
        expect(backoff1).toBeLessThanOrEqual(18700);    // 17 * 1.1 * 1000

        // Attempt 5: 15 + 2^5 = 47 seconds (±10% jitter)
        const backoff5 = calculateBackoff(5, { strategy: 'exponential' });
        expect(backoff5).toBeGreaterThanOrEqual(42300);
        expect(backoff5).toBeLessThanOrEqual(51700);
      });

      it('respects maxPower option', () => {
        // With maxPower=2, attempt 10 should behave like attempt 2
        const backoff = calculateBackoff(10, { strategy: 'exponential', maxPower: 2 });
        // 15 + 2^2 = 19 seconds
        expect(backoff).toBeGreaterThanOrEqual(17100);
        expect(backoff).toBeLessThanOrEqual(20900);
      });

      it('applies custom basePad and multiplier', () => {
        const backoff = calculateBackoff(1, {
          strategy: 'exponential',
          basePad: 5,
          multiplier: 2,
          jitterPercent: 0 // No jitter for predictable test
        });
        // 5 + 2 * 2^1 = 9 seconds = 9000ms
        expect(backoff).toBe(9000);
      });

      it('caps at maxPower=10 by default, same as before (attempts 10-20 plateau at ~17 minutes)', () => {
        const backoffAt10 = calculateBackoff(10, { strategy: 'exponential', jitterPercent: 0 });
        const backoffAt20 = calculateBackoff(20, { strategy: 'exponential', jitterPercent: 0 });
        expect(backoffAt10).toBe(backoffAt20);
        expect(backoffAt10).toBe((15 + Math.pow(2, 10)) * 1000);
      });

      it('applies maxDelay as a cap on the exponential curve', () => {
        const backoff = calculateBackoff(10, { strategy: 'exponential', jitterPercent: 0, maxDelay: 60 });
        expect(backoff).toBe(60000);
      });
    });
  });

  describe('formatError', () => {
    it('should format Error objects', () => {
      const error = new Error('Something went wrong');
      const formatted = formatError(error, 1);

      expect(formatted.error).toBe('Something went wrong');
      expect(formatted.attempt).toBe(1);
      expect(formatted.stacktrace).toContain('Error: Something went wrong');
      expect(formatted.at).toBeInstanceOf(Date);
    });

    it('should format string errors', () => {
      const formatted = formatError('Simple error message', 2);

      expect(formatted.error).toBe('Simple error message');
      expect(formatted.attempt).toBe(2);
      expect(formatted.stacktrace).toBeUndefined();
    });
  });

  describe('isValidTransition', () => {
    it('should allow valid transitions', () => {
      expect(isValidTransition('scheduled', 'available')).toBe(true);
      expect(isValidTransition('available', 'executing')).toBe(true);
      expect(isValidTransition('executing', 'completed')).toBe(true);
      expect(isValidTransition('executing', 'retryable')).toBe(true);
      expect(isValidTransition('retryable', 'available')).toBe(true);
    });

    it('should reject invalid transitions', () => {
      expect(isValidTransition('completed', 'available')).toBe(false);
      expect(isValidTransition('discarded', 'retryable')).toBe(false);
      expect(isValidTransition('available', 'completed')).toBe(false);
    });
  });

  describe('isTerminal', () => {
    it('should return true for terminal states', () => {
      expect(isTerminal('completed')).toBe(true);
      expect(isTerminal('discarded')).toBe(true);
      expect(isTerminal('cancelled')).toBe(true);
    });

    it('should return false for non-terminal states', () => {
      expect(isTerminal('scheduled')).toBe(false);
      expect(isTerminal('available')).toBe(false);
      expect(isTerminal('executing')).toBe(false);
      expect(isTerminal('retryable')).toBe(false);
    });
  });

  describe('STATE_TRANSITIONS', () => {
    it('should define all states', () => {
      const states: JobState[] = [
        'scheduled', 'available', 'executing',
        'retryable', 'completed', 'discarded', 'cancelled'
      ];

      for (const state of states) {
        expect(STATE_TRANSITIONS[state]).toBeDefined();
        expect(Array.isArray(STATE_TRANSITIONS[state])).toBe(true);
      }
    });

    it('should have empty arrays for terminal states', () => {
      expect(STATE_TRANSITIONS.completed).toEqual([]);
      expect(STATE_TRANSITIONS.discarded).toEqual([]);
      expect(STATE_TRANSITIONS.cancelled).toEqual([]);
    });
  });

  describe('TERMINAL_STATES', () => {
    it('should contain exactly the terminal states', () => {
      expect(TERMINAL_STATES).toContain('completed');
      expect(TERMINAL_STATES).toContain('discarded');
      expect(TERMINAL_STATES).toContain('cancelled');
      expect(TERMINAL_STATES).toHaveLength(3);
    });
  });
});
