import { redactLogValue, type LogValue } from './redaction.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  readonly event: string;
  readonly level: LogLevel;
  readonly service: string;
  readonly timestamp: string;
  readonly context?: LogValue;
}

export interface Logger {
  log(level: LogLevel, event: string, context?: unknown): void;
  debug(event: string, context?: unknown): void;
  info(event: string, context?: unknown): void;
  warn(event: string, context?: unknown): void;
  error(event: string, context?: unknown): void;
}

export interface LoggerOptions {
  readonly service: string;
  readonly minimumLevel?: LogLevel;
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
}

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogger(options: LoggerOptions): Logger {
  const minimumLevel = options.minimumLevel ?? 'info';
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  const log = (level: LogLevel, event: string, context?: unknown): void => {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minimumLevel]) {
      return;
    }

    const base: LogRecord = {
      event,
      level,
      service: options.service,
      timestamp: now().toISOString(),
      ...(context === undefined ? {} : { context: redactLogValue(context) }),
    };
    write(JSON.stringify(base));
  };

  return {
    log,
    debug: (event, context) => {
      log('debug', event, context);
    },
    info: (event, context) => {
      log('info', event, context);
    },
    warn: (event, context) => {
      log('warn', event, context);
    },
    error: (event, context) => {
      log('error', event, context);
    },
  };
}
