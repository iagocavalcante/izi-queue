import { telemetry } from '../src/core/telemetry.js';

describe('Telemetry', () => {
  beforeEach(() => {
    telemetry.off();
  });

  describe('on / emit', () => {
    it('should emit events to subscribers', () => {
      const handler = jest.fn();
      telemetry.on('job:start', handler);

      telemetry.emit('job:start', { queue: 'default' });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'job:start',
          queue: 'default',
          timestamp: expect.any(Date)
        })
      );
    });

    it('should support wildcard subscriptions', () => {
      const handler = jest.fn();
      telemetry.on('*', handler);

      telemetry.emit('job:start', {});
      telemetry.emit('job:complete', {});
      telemetry.emit('queue:start', {});

      expect(handler).toHaveBeenCalledTimes(3);
    });

    it('should call both specific and wildcard handlers', () => {
      const specificHandler = jest.fn();
      const wildcardHandler = jest.fn();

      telemetry.on('job:complete', specificHandler);
      telemetry.on('*', wildcardHandler);

      telemetry.emit('job:complete', { queue: 'test' });

      expect(specificHandler).toHaveBeenCalledTimes(1);
      expect(wildcardHandler).toHaveBeenCalledTimes(1);
    });

    it('should not call handlers for other events', () => {
      const handler = jest.fn();
      telemetry.on('job:start', handler);

      telemetry.emit('job:complete', {});

      expect(handler).not.toHaveBeenCalled();
    });

    it('should ignore errors in handlers', () => {
      const errorHandler = jest.fn(() => {
        throw new Error('Handler error');
      });
      const successHandler = jest.fn();

      telemetry.on('job:start', errorHandler);
      telemetry.on('job:start', successHandler);

      // Should not throw
      expect(() => telemetry.emit('job:start', {})).not.toThrow();
      expect(successHandler).toHaveBeenCalled();
    });
  });

  describe('unsubscribe', () => {
    it('should return unsubscribe function', () => {
      const handler = jest.fn();
      const unsubscribe = telemetry.on('job:start', handler);

      telemetry.emit('job:start', {});
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();

      telemetry.emit('job:start', {});
      expect(handler).toHaveBeenCalledTimes(1); // Still 1, not called again
    });
  });

  describe('once', () => {
    it('should call handler only once', () => {
      const handler = jest.fn();
      telemetry.once('job:start', handler);

      telemetry.emit('job:start', {});
      telemetry.emit('job:start', {});
      telemetry.emit('job:start', {});

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should return unsubscribe function for once', () => {
      const handler = jest.fn();
      const unsubscribe = telemetry.once('job:start', handler);

      // Unsubscribe before any emit
      unsubscribe();

      telemetry.emit('job:start', {});
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('off', () => {
    it('should remove all handlers for specific event', () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();
      const handler3 = jest.fn();

      telemetry.on('job:start', handler1);
      telemetry.on('job:start', handler2);
      telemetry.on('job:complete', handler3);

      telemetry.off('job:start');

      telemetry.emit('job:start', {});
      telemetry.emit('job:complete', {});

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
      expect(handler3).toHaveBeenCalledTimes(1);
    });

    it('should remove all handlers when called without argument', () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();

      telemetry.on('job:start', handler1);
      telemetry.on('job:complete', handler2);

      telemetry.off();

      telemetry.emit('job:start', {});
      telemetry.emit('job:complete', {});

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });
  });

  describe('payload structure', () => {
    it('should include all provided data in payload', () => {
      const handler = jest.fn();
      telemetry.on('job:complete', handler);

      const mockJob = { id: 1, worker: 'Test' };
      telemetry.emit('job:complete', {
        job: mockJob as any,
        queue: 'default',
        duration: 100,
        result: { success: true }
      });

      expect(handler).toHaveBeenCalledWith({
        event: 'job:complete',
        job: mockJob,
        queue: 'default',
        duration: 100,
        result: { success: true },
        timestamp: expect.any(Date)
      });
    });

    it('should include error in payload', () => {
      const handler = jest.fn();
      telemetry.on('job:error', handler);

      const error = new Error('Test error');
      telemetry.emit('job:error', { error });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ error })
      );
    });
  });
});
