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
    it('should calculate exponential backoff with default options', () => {
      // Attempt 1: 15 + 2^1 = 17 seconds (±10% jitter)
      const backoff1 = calculateBackoff(1);
      expect(backoff1).toBeGreaterThanOrEqual(15300); // 17 * 0.9 * 1000
      expect(backoff1).toBeLessThanOrEqual(18700);    // 17 * 1.1 * 1000

      // Attempt 5: 15 + 2^5 = 47 seconds (±10% jitter)
      const backoff5 = calculateBackoff(5);
      expect(backoff5).toBeGreaterThanOrEqual(42300);
      expect(backoff5).toBeLessThanOrEqual(51700);
    });

    it('should respect maxPower option', () => {
      // With maxPower=2, attempt 10 should behave like attempt 2
      const backoff = calculateBackoff(10, { maxPower: 2 });
      // 15 + 2^2 = 19 seconds
      expect(backoff).toBeGreaterThanOrEqual(17100);
      expect(backoff).toBeLessThanOrEqual(20900);
    });

    it('should apply custom basePad and multiplier', () => {
      const backoff = calculateBackoff(1, {
        basePad: 5,
        multiplier: 2,
        jitterPercent: 0 // No jitter for predictable test
      });
      // 5 + 2 * 2^1 = 9 seconds = 9000ms
      expect(backoff).toBe(9000);
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
