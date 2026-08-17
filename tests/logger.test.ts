import Database from 'better-sqlite3';
import { consoleLogger, createSQLiteAdapter } from '../src/index.js';
import type { Logger } from '../src/types.js';

function createMockLogger(): Logger & {
  debug: jest.Mock;
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
} {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
}

describe('consoleLogger', () => {
  let debugSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('routes debug() to console.debug, prefixed', () => {
    consoleLogger.debug('Attempting to reconnect', { attempt: 1 });

    expect(debugSpy).toHaveBeenCalledWith('[izi-queue] Attempting to reconnect', { attempt: 1 });
  });

  it('routes info() to console.log, prefixed', () => {
    consoleLogger.info('Applying migration', { version: 1 });

    expect(logSpy).toHaveBeenCalledWith('[izi-queue] Applying migration', { version: 1 });
  });

  it('routes warn() to console.warn, prefixed', () => {
    consoleLogger.warn('something odd');

    expect(warnSpy).toHaveBeenCalledWith('[izi-queue] something odd');
  });

  it('routes error() to console.error, prefixed, and preserves the pre-#40 behavior of always surfacing errors', () => {
    const error = new Error('boom');
    consoleLogger.error('Error staging jobs', { error });

    expect(errorSpy).toHaveBeenCalledWith('[izi-queue] Error staging jobs', { error });
  });

  it('omits the trailing argument entirely when no metadata is given', () => {
    consoleLogger.info('Reconnected successfully');

    expect(logSpy).toHaveBeenCalledWith('[izi-queue] Reconnected successfully');
    expect(logSpy.mock.calls[0]).toHaveLength(1);
  });
});

describe('SQLiteAdapter logger injection', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(async () => {
    db.close();
  });

  it('defaults to consoleLogger, preserving the old console.log-on-migrate behavior', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const adapter = createSQLiteAdapter(db);
    await adapter.migrate();

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Applying migration'),
      expect.objectContaining({ version: expect.any(Number), name: expect.any(String) })
    );

    logSpy.mockRestore();
  });

  it('routes migration progress through an injected logger instead of the console', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createMockLogger();

    const adapter = createSQLiteAdapter(db, logger);
    await adapter.migrate();

    expect(logger.info).toHaveBeenCalledWith(
      'Applying migration',
      expect.objectContaining({ version: expect.any(Number), name: expect.any(String) })
    );
    // Nothing should have gone to the console once a custom logger is supplied.
    expect(logSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });
});
