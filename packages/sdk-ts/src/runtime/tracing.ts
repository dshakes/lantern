/**
 * Lightweight OTel-compatible tracing helpers for the Lantern SDK runtime.
 *
 * We ship a thin interface so the runtime modules create spans without
 * importing the full OTel SDK directly. When running inside a Lantern
 * sandbox the sidecar provides a full OTel collector on localhost; the
 * spans created here flow through it. In dev mode, spans are no-ops.
 */

/** Minimal span interface compatible with OTel's Span contract. */
export interface Span {
  /** Set a string attribute on the span. */
  setAttribute(key: string, value: string | number | boolean): void;
  /** Record an error on the span. */
  recordException(err: unknown): void;
  /** Mark the span as ended. */
  end(): void;
}

/** Minimal tracer interface. */
export interface Tracer {
  /** Start a new span. */
  startSpan(name: string, attributes?: Record<string, string | number | boolean>): Span;
}

/** Noop span returned in dev mode or when the OTel SDK is not available. */
class NoopSpan implements Span {
  setAttribute(_key: string, _value: string | number | boolean): void {
    /* noop */
  }
  recordException(_err: unknown): void {
    /* noop */
  }
  end(): void {
    /* noop */
  }
}

/** Noop tracer returned in dev mode. */
class NoopTracer implements Tracer {
  startSpan(_name: string, _attributes?: Record<string, string | number | boolean>): Span {
    return new NoopSpan();
  }
}

/**
 * OTel-backed tracer that delegates to `@opentelemetry/api` when available.
 * If the package is not installed (common in dev mode), it silently falls
 * back to no-op spans.
 */
class OtelTracer implements Tracer {
  private inner: Tracer;

  constructor(serviceName: string) {
    try {
      // Dynamic import at construction time; OTel is optional.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const api = require("@opentelemetry/api") as {
        trace: {
          getTracer(name: string): {
            startSpan(name: string, options?: { attributes?: Record<string, string | number | boolean> }): Span;
          };
        };
      };
      const tracer = api.trace.getTracer(serviceName);
      this.inner = {
        startSpan(name: string, attributes?: Record<string, string | number | boolean>): Span {
          return tracer.startSpan(name, { attributes });
        },
      };
    } catch {
      this.inner = new NoopTracer();
    }
  }

  startSpan(name: string, attributes?: Record<string, string | number | boolean>): Span {
    return this.inner.startSpan(name, attributes);
  }
}

let _tracer: Tracer | undefined;

/**
 * Get the singleton tracer instance.
 * In production (LANTERN_RUNTIME=true) this attempts to load the OTel SDK.
 * Otherwise it returns a no-op tracer.
 */
export function getTracer(): Tracer {
  if (!_tracer) {
    if (process.env.LANTERN_RUNTIME === "true") {
      _tracer = new OtelTracer("@lantern/sdk");
    } else {
      _tracer = new NoopTracer();
    }
  }
  return _tracer;
}

/**
 * Run `fn` inside a traced span. The span is ended automatically on
 * completion or error. Exceptions are recorded on the span and re-thrown.
 */
export async function traced<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = getTracer().startSpan(name, attributes);
  try {
    const result = await fn(span);
    span.end();
    return result;
  } catch (err) {
    span.recordException(err);
    span.end();
    throw err;
  }
}
