import { describe, expect, it } from 'vitest';

import { MetricRegistry } from '../src/metrics.js';

describe('MetricRegistry', () => {
  it('renders valid counters and gauges deterministically as Prometheus exposition', () => {
    const registry = new MetricRegistry();
    registry.defineCounter('z_requests_total', 'Requests \\ accepted\nby this service.');
    registry.defineGauge('a_service_ready', 'Whether the service is ready.');

    registry.increment('z_requests_total', 2.5);
    registry.set('a_service_ready', 1);

    expect(registry.render()).toBe(
      [
        '# HELP a_service_ready Whether the service is ready.',
        '# TYPE a_service_ready gauge',
        'a_service_ready 1',
        '# HELP z_requests_total Requests \\\\ accepted\\nby this service.',
        '# TYPE z_requests_total counter',
        'z_requests_total 2.5',
        '',
      ].join('\n'),
    );
  });

  it.each(['', '9starts_with_a_number', 'contains-hyphen', 'contains space'])(
    'refuses invalid Prometheus metric name %j',
    (name) => {
      const registry = new MetricRegistry();
      expect(() => {
        registry.defineCounter(name, 'Valid help text.');
      }).toThrow('Invalid Prometheus metric name');
    },
  );

  it.each(['', 'carriage\rreturn'])('refuses invalid metric help %j', (help) => {
    const registry = new MetricRegistry();
    expect(() => {
      registry.defineGauge('valid_metric', help);
    }).toThrow('Metric help must be a non-empty single logical line');
  });

  it('refuses duplicate definitions and operations with the wrong metric kind', () => {
    const registry = new MetricRegistry();
    registry.defineCounter('requests_total', 'Accepted requests.');
    registry.defineGauge('queue_depth', 'Current queue depth.');

    expect(() => {
      registry.defineCounter('requests_total', 'A second definition.');
    }).toThrow('Metric is already defined');
    expect(() => {
      registry.set('requests_total', 1);
    }).toThrow('Metric requests_total is a counter, not a gauge');
    expect(() => {
      registry.increment('queue_depth');
    }).toThrow('Metric queue_depth is a gauge, not a counter');
    expect(() => registry.get('missing_metric')).toThrow('Metric is not defined');
  });

  it.each([-1, -Number.MIN_VALUE, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'refuses invalid or negative counter increment %s without mutating the counter',
    (amount) => {
      const registry = new MetricRegistry();
      registry.defineCounter('requests_total', 'Accepted requests.');

      expect(() => {
        registry.increment('requests_total', amount);
      }).toThrow('Counter increment must be finite and non-negative');
      expect(registry.get('requests_total')).toBe(0);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'refuses non-finite gauge value %s without mutating the gauge',
    (value) => {
      const registry = new MetricRegistry();
      registry.defineGauge('queue_depth', 'Current queue depth.');

      expect(() => {
        registry.set('queue_depth', value);
      }).toThrow('Gauge value must be finite');
      expect(registry.get('queue_depth')).toBe(0);
    },
  );

  it('refuses a finite increment when it would overflow a counter to a non-finite value', () => {
    const registry = new MetricRegistry();
    registry.defineCounter('bytes_total', 'Accepted bytes.');
    registry.increment('bytes_total', Number.MAX_VALUE);

    expect(() => {
      registry.increment('bytes_total', Number.MAX_VALUE);
    }).toThrow('Counter value must remain finite');
    expect(registry.get('bytes_total')).toBe(Number.MAX_VALUE);
  });
});
