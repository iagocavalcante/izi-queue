# Contributing to izi-queue

Thank you for your interest in contributing to izi-queue! This document provides guidelines and information for contributors.

## Code of Conduct

Be respectful and constructive in all interactions. We're all here to build something useful together.

## Getting Started

### Prerequisites

- Node.js 18.0.0 or higher
- npm 8.0.0 or higher
- Git

### Setup

```bash
# Fork and clone the repository
git clone https://github.com/YOUR_USERNAME/izi-queue.git
cd izi-queue

# Install dependencies
npm install

# Run tests to verify setup
npm test
```

## Development Workflow

### Branch Naming

- `feature/description` - New features
- `fix/description` - Bug fixes
- `docs/description` - Documentation only
- `refactor/description` - Code refactoring
- `test/description` - Test additions or fixes

### Making Changes

1. Create a branch from `main`
2. Make your changes
3. Write or update tests
4. Run the full test suite
5. Run linting
6. Submit a pull request

### Commands

```bash
# Build the project
npm run build

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Run linting
npm run lint

# Watch mode for development
npm run dev

# Run benchmarks
npm run benchmark
```

## Code Style

### TypeScript Guidelines

- Use strict TypeScript - the project has `strict: true` enabled
- Export types explicitly when they're part of the public API
- Use `interface` for object shapes, `type` for unions and aliases
- Avoid `any` - use `unknown` if the type is truly unknown

### Naming Conventions

- **Files**: kebab-case (`izi-queue.ts`, `worker-thread.ts`)
- **Classes**: PascalCase (`IziQueue`, `BasePlugin`)
- **Functions**: camelCase (`registerWorker`, `executeWorker`)
- **Constants**: UPPER_SNAKE_CASE for true constants (`STATE_TRANSITIONS`)
- **Types/Interfaces**: PascalCase (`Job`, `WorkerDefinition`)

### Code Patterns

Follow existing patterns in the codebase:

- **Factory Functions**: Use `createX()` pattern for creating instances
  ```typescript
  export function createSQLiteAdapter(db: Database): SQLiteAdapter {
    return new SQLiteAdapter(db);
  }
  ```

- **Worker Results**: Return structured results, don't throw
  ```typescript
  return WorkerResults.ok();
  return WorkerResults.error('Something went wrong');
  ```

- **Async/Await**: Use async/await exclusively, no callbacks

- **Error Handling**: Catch and format errors, don't let them propagate unexpectedly

See `CLAUDE.md` for detailed architecture patterns.

## Testing

### Test Structure

Tests are located in `/tests` and follow the pattern `*.test.ts`.

```
tests/
├── izi-queue.test.ts      # Main queue tests
├── worker.test.ts         # Worker registry tests
├── job.test.ts            # Job helper tests
├── queue.test.ts          # Queue state tests
├── plugins.test.ts        # Plugin tests
├── sqlite-adapter.test.ts # SQLite adapter tests
├── telemetry.test.ts      # Telemetry system tests
├── integration.test.ts    # Full integration tests
└── isolation/             # Worker isolation tests
```

### Writing Tests

- Use in-memory SQLite for fast tests
- Clear worker registry between tests (`clearWorkers()`)
- Test both success and failure cases
- Use the `createMockJob()` helper for test data

```typescript
import { clearWorkers, registerWorker, defineWorker } from '../src/core/worker.js';
import { createMockJob } from './helpers.js';

describe('MyFeature', () => {
  beforeEach(() => {
    clearWorkers();
  });

  it('should do something', async () => {
    const worker = defineWorker('test', async () => WorkerResults.ok());
    registerWorker(worker);

    const job = createMockJob({ worker: 'test' });
    // ... test logic
  });
});
```

### Running Specific Tests

```bash
# Run a specific test file
npm test -- worker.test.ts

# Run tests matching a pattern
npm test -- --testNamePattern="should handle"

# Run with verbose output
npm test -- --verbose
```

## Pull Request Guidelines

### Before Submitting

- [ ] All tests pass (`npm test`)
- [ ] Linting passes (`npm run lint`)
- [ ] Code builds successfully (`npm run build`)
- [ ] New features have tests
- [ ] Documentation is updated if needed

### PR Description

Include:
- What the change does
- Why it's needed
- How to test it
- Any breaking changes

### Review Process

1. Maintainers will review your PR
2. Address any feedback
3. Once approved, your PR will be merged

## Adding New Features

### New Database Adapter

1. Create adapter in `src/database/` extending the adapter pattern
2. Implement the `DatabaseAdapter` interface
3. Add tests in `tests/`
4. Add factory function (`createXAdapter`)
5. Export from `src/database/index.ts`

### New Plugin

1. Create plugin in `src/plugins/` extending `BasePlugin`
2. Implement `onStart()` and optionally `onStop()`, `validate()`
3. Add tests in `tests/plugins.test.ts`
4. Export from `src/plugins/index.ts`

### New Worker Feature

1. Update types in `src/types.ts`
2. Implement in `src/core/worker.ts`
3. Add tests in `tests/worker.test.ts`

## Reporting Issues

### Bug Reports

Include:
- izi-queue version
- Node.js version
- Database being used
- Minimal reproduction code
- Expected vs actual behavior

### Feature Requests

Include:
- Use case description
- Proposed API (if any)
- Why existing features don't suffice

## Questions?

- Open a [GitHub Discussion](https://github.com/IagoCavalcante/izi-queue/discussions)
- Check existing issues and discussions first

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
