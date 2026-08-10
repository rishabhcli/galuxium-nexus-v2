const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

type MetricKind = 'counter' | 'gauge';

interface MetricDefinition {
  readonly help: string;
  readonly kind: MetricKind;
  value: number;
}

function assertMetricName(name: string): void {
  if (!METRIC_NAME.test(name)) {
    throw new Error(`Invalid Prometheus metric name: ${name}`);
  }
}

function escapeHelp(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n');
}

export class MetricRegistry {
  readonly #metrics = new Map<string, MetricDefinition>();

  defineCounter(name: string, help: string): void {
    this.#define(name, help, 'counter');
  }

  defineGauge(name: string, help: string): void {
    this.#define(name, help, 'gauge');
  }

  increment(name: string, amount = 1): void {
    const metric = this.#required(name, 'counter');
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`Counter increment must be finite and non-negative: ${name}`);
    }
    const nextValue = metric.value + amount;
    if (!Number.isFinite(nextValue)) {
      throw new Error(`Counter value must remain finite: ${name}`);
    }
    metric.value = nextValue;
  }

  set(name: string, value: number): void {
    const metric = this.#required(name, 'gauge');
    if (!Number.isFinite(value)) {
      throw new Error(`Gauge value must be finite: ${name}`);
    }
    metric.value = value;
  }

  get(name: string): number {
    return this.#required(name).value;
  }

  render(): string {
    const lines: string[] = [];
    const entries = [...this.#metrics.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );
    for (const [name, definition] of entries) {
      lines.push(`# HELP ${name} ${escapeHelp(definition.help)}`);
      lines.push(`# TYPE ${name} ${definition.kind}`);
      lines.push(`${name} ${String(definition.value)}`);
    }
    return `${lines.join('\n')}\n`;
  }

  #define(name: string, help: string, kind: MetricKind): void {
    assertMetricName(name);
    if (help.length === 0 || help.includes('\r')) {
      throw new Error(`Metric help must be a non-empty single logical line: ${name}`);
    }
    if (this.#metrics.has(name)) {
      throw new Error(`Metric is already defined: ${name}`);
    }
    this.#metrics.set(name, { help, kind, value: 0 });
  }

  #required(name: string, kind?: MetricKind): MetricDefinition {
    assertMetricName(name);
    const metric = this.#metrics.get(name);
    if (metric === undefined) {
      throw new Error(`Metric is not defined: ${name}`);
    }
    if (kind !== undefined && metric.kind !== kind) {
      throw new Error(`Metric ${name} is a ${metric.kind}, not a ${kind}`);
    }
    return metric;
  }
}

export function assertLabelName(name: string): void {
  if (!LABEL_NAME.test(name)) {
    throw new Error(`Invalid Prometheus label name: ${name}`);
  }
}
