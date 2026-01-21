# Creating Plugins for izi-queue

Use this skill when implementing new plugins to extend izi-queue functionality.

## Plugin Architecture

Plugins extend `BasePlugin` and implement lifecycle hooks:

```typescript
import { BasePlugin, PluginContext } from 'izi-queue/plugins';

export class MyPlugin extends BasePlugin {
  readonly name = 'my_plugin';

  private interval: number;

  constructor(options: { interval?: number } = {}) {
    super();
    this.interval = options.interval ?? 60000; // Default: 1 minute
  }

  protected async onStart(): Promise<void> {
    // Start your plugin logic
    this.timer = setInterval(() => this.tick(), this.interval);
  }

  protected async onStop(): Promise<void> {
    // Cleanup (optional - timer is auto-cleared by BasePlugin)
  }

  validate(): string[] {
    const errors: string[] = [];
    if (this.interval < 1000) {
      errors.push('Interval must be at least 1000ms');
    }
    return errors;
  }

  private async tick(): Promise<void> {
    if (!this.context || !this.running) return;

    try {
      // Your periodic logic here
      // Access database via this.context.database
      // Access node ID via this.context.node
      // Access queue names via this.context.queues
    } catch (error) {
      console.error(`[${this.name}] Error:`, error);
    }
  }
}
```

## Plugin Context

The `PluginContext` provides:

```typescript
interface PluginContext {
  database: DatabaseAdapter;  // Database operations
  node: string;               // Current node identifier
  queues: string[];           // List of queue names
}
```

## Built-in Plugin Examples

### LifelinePlugin (Rescue Stuck Jobs)

```typescript
export class LifelinePlugin extends BasePlugin {
  readonly name = 'lifeline';

  constructor(private options: { rescueAfter?: number; interval?: number } = {}) {
    super();
  }

  protected async onStart(): Promise<void> {
    const interval = this.options.interval ?? 60000;
    this.timer = setInterval(() => this.rescue(), interval);
  }

  private async rescue(): Promise<void> {
    if (!this.context || !this.running) return;

    const rescueAfter = this.options.rescueAfter ?? 300;
    const count = await this.context.database.rescueStuckJobs(rescueAfter);

    if (count > 0) {
      telemetry.emit('job:rescue', { timestamp: new Date() });
    }
  }
}
```

### PrunerPlugin (Cleanup Old Jobs)

```typescript
export class PrunerPlugin extends BasePlugin {
  readonly name = 'pruner';

  constructor(private options: { maxAge?: number; interval?: number } = {}) {
    super();
  }

  protected async onStart(): Promise<void> {
    const interval = this.options.interval ?? 60000;
    this.timer = setInterval(() => this.prune(), interval);
  }

  private async prune(): Promise<void> {
    if (!this.context || !this.running) return;

    const maxAge = this.options.maxAge ?? 86400;
    await this.context.database.pruneJobs(maxAge);
  }
}
```

## Plugin Validation

Implement `validate()` to check configuration:

```typescript
validate(): string[] {
  const errors: string[] = [];

  if (this.options.interval && this.options.interval < 1000) {
    errors.push('Interval must be at least 1000ms');
  }

  if (this.options.maxAge && this.options.maxAge < 60) {
    errors.push('Max age must be at least 60 seconds');
  }

  return errors;
}
```

Validation runs before the queue starts. Return an array of error messages.

## Emitting Telemetry

Plugins can emit telemetry events:

```typescript
import { telemetry } from '../core/telemetry.js';

private async tick(): Promise<void> {
  try {
    const result = await this.doWork();
    telemetry.emit('plugin:custom_event', {
      timestamp: new Date(),
      result
    });
  } catch (error) {
    telemetry.emit('plugin:error', {
      timestamp: new Date(),
      error: error instanceof Error ? error : new Error(String(error))
    });
  }
}
```

## Using Plugins

```typescript
import { IziQueue, LifelinePlugin, PrunerPlugin } from 'izi-queue';

const queue = new IziQueue({
  database: adapter,
  queues: { default: 10 },
  plugins: [
    new LifelinePlugin({ rescueAfter: 300, interval: 60000 }),
    new PrunerPlugin({ maxAge: 86400, interval: 3600000 }),
    new MyCustomPlugin({ option: 'value' }),
  ],
});
```

## Testing Plugins

```typescript
describe('MyPlugin', () => {
  let plugin: MyPlugin;
  let mockContext: PluginContext;

  beforeEach(() => {
    plugin = new MyPlugin({ interval: 1000 });
    mockContext = {
      database: createMockAdapter(),
      node: 'test-node',
      queues: ['default'],
    };
  });

  afterEach(async () => {
    await plugin.stop();
  });

  it('should validate configuration', () => {
    const errors = plugin.validate();
    expect(errors).toHaveLength(0);
  });

  it('should start and stop correctly', async () => {
    await plugin.start(mockContext);
    expect(plugin.running).toBe(true);

    await plugin.stop();
    expect(plugin.running).toBe(false);
  });
});
```

## File Organization

Place plugins in `src/plugins/`:

```
src/plugins/
├── index.ts        # Export all plugins
├── plugin.ts       # BasePlugin class
├── lifeline.ts     # Built-in plugin
├── pruner.ts       # Built-in plugin
└── my-plugin.ts    # Your new plugin
```

Export from `src/plugins/index.ts`:

```typescript
export { BasePlugin, type Plugin, type PluginContext } from './plugin.js';
export { LifelinePlugin } from './lifeline.js';
export { PrunerPlugin } from './pruner.js';
export { MyPlugin } from './my-plugin.js';
```
