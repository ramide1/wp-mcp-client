/**
 * Structured logging with secret redaction.
 *
 * Two formats are supported:
 * - `text` (default): human readable, one line per event.
 * - `json`: one JSON object per line, ready for log shippers.
 *
 * Configuration (environment variables):
 * - LOG_LEVEL: `debug` | `info` | `warn` | `error` (default: `info`)
 * - LOG_FORMAT: `text` | `json` (default: `text`)
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

const LEVEL_ORDER: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40
};

const VALID_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** Field names whose values are never written to the log. */
const SENSITIVE_KEY = /(authorization|token|secret|password|passwd|api[-_]?key|apikey|credential|cookie|private[-_]?key|client[-_]?secret)/i;

export const REDACTED = '[redacted]';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Replace sensitive values by their field name.
 * Nested objects and arrays are traversed up to `maxDepth` levels.
 */
export const redact = (value: unknown, key = '', depth = 0): unknown => {
    if (depth > 6) return '[depth-limit]';
    if (SENSITIVE_KEY.test(key)) return REDACTED;
    if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: value.stack };
    }
    if (Array.isArray(value)) return value.map(item => redact(item, key, depth + 1));
    if (isPlainObject(value)) {
        const out: Record<string, unknown> = {};
        for (const [childKey, childValue] of Object.entries(value)) {
            out[childKey] = redact(childValue, childKey, depth + 1);
        }
        return out;
    }
    if (typeof value === 'string' && value.length > 2000) {
        return value.substring(0, 2000) + `... [truncated ${value.length - 2000} chars]`;
    }
    if (typeof value === 'bigint') return value.toString();
    return value;
};

const currentLevel = (): LogLevel => {
    const raw = (process.env.LOG_LEVEL ?? '').trim().toLowerCase();
    return (VALID_LEVELS as string[]).includes(raw) ? (raw as LogLevel) : 'info';
};

const currentFormat = (): 'text' | 'json' => {
    const raw = (process.env.LOG_FORMAT ?? '').trim().toLowerCase();
    return raw === 'json' ? 'json' : 'text';
};

const formatValue = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
};

const emit = (level: LogLevel, scope: string, message: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;

    const safeFields: LogFields = {};
    for (const [key, value] of Object.entries(fields ?? {})) {
        safeFields[key] = redact(value, key);
    }

    const timestamp = new Date().toISOString();

    if (currentFormat() === 'json') {
        const payload: Record<string, unknown> = { ts: timestamp, level, scope, msg: message };
        for (const [key, value] of Object.entries(safeFields)) {
            payload[key] = value;
        }
        console.log(JSON.stringify(payload));
        return;
    }

    const suffix = Object.keys(safeFields).length > 0
        ? ' ' + Object.entries(safeFields)
            .map(([key, value]) => `${key}=${formatValue(value)}`)
            .join(' ')
        : '';
    const line = `${timestamp} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${suffix}`;

    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
};

/**
 * Create a logger bound to a scope (usually the module name).
 */
export const createLogger = (scope: string) => ({
    debug: (message: string, fields?: LogFields) => emit('debug', scope, message, fields),
    info: (message: string, fields?: LogFields) => emit('info', scope, message, fields),
    warn: (message: string, fields?: LogFields) => emit('warn', scope, message, fields),
    error: (message: string, fields?: LogFields) => emit('error', scope, message, fields)
});

export type Logger = ReturnType<typeof createLogger>;

export const logger = createLogger('app');
