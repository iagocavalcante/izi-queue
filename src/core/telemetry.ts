import type { TelemetryEvent, TelemetryHandler, TelemetryPayload } from '../types.js';

class Telemetry {
  private handlers: Map<TelemetryEvent | '*', Set<TelemetryHandler>> = new Map();

  on(event: TelemetryEvent | '*', handler: TelemetryHandler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);

    return () => {
      this.handlers.get(event)?.delete(handler);
    };
  }

  once(event: TelemetryEvent | '*', handler: TelemetryHandler): () => void {
    const wrapper: TelemetryHandler = (payload) => {
      unsubscribe();
      handler(payload);
    };
    const unsubscribe = this.on(event, wrapper);
    return unsubscribe;
  }

  emit(event: TelemetryEvent, payload: Omit<TelemetryPayload, 'event' | 'timestamp'>): void {
    const fullPayload: TelemetryPayload = {
      ...payload,
      event,
      timestamp: new Date()
    };

    this.handlers.get(event)?.forEach(handler => {
      try {
        handler(fullPayload);
      } catch {
        // Ignore handler errors
      }
    });

    this.handlers.get('*')?.forEach(handler => {
      try {
        handler(fullPayload);
      } catch {
        // Ignore handler errors
      }
    });
  }

  off(event?: TelemetryEvent | '*'): void {
    if (event) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
    }
  }
}

export const telemetry = new Telemetry();
