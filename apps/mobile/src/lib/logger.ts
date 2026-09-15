export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogSink = (level: LogLevel, message: string, context?: Record<string, unknown>) => void;

export interface Logger {
  debug: (message: string, context?: Record<string, unknown>) => void;
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
}

interface CreateLoggerOptions {
  isDevelopment: boolean;
  sink: LogSink;
}

/** 本番で出力するレベル。debug と info は開発時のみ */
const PRODUCTION_LEVELS: readonly LogLevel[] = ['warn', 'error'];

export function createLogger({ isDevelopment, sink }: CreateLoggerOptions): Logger {
  const emit = (level: LogLevel) => (message: string, context?: Record<string, unknown>) => {
    if (!isDevelopment && !PRODUCTION_LEVELS.includes(level)) {
      return;
    }
    sink(level, message, context);
  };

  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
  };
}

/* eslint-disable no-console */
// アプリ内で console を直接呼んでよいのはここだけ。差し替え可能にするため sink として切り出す
const consoleSink: LogSink = (level, message, context) => {
  const payload = context ? [message, context] : [message];
  if (level === 'error') console.error(...payload);
  else if (level === 'warn') console.warn(...payload);
  else console.log(...payload);
};
/* eslint-enable no-console */

/** アプリ全体で使う既定のロガー。コンポーネントからは console を直接呼ばずこれを使う */
export const logger = createLogger({ isDevelopment: __DEV__, sink: consoleSink });
