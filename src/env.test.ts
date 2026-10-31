import { describe, expect, test, afterEach } from 'bun:test';
import { secondsFromEnv, timeoutFromEnv, intFromEnv } from './env';

const touched: string[] = [];

const setEnv = (name: string, value: string | undefined): void => {
    touched.push(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
};

afterEach(() => {
    while (touched.length > 0) {
        const name = touched.pop();
        if (name) delete process.env[name];
    }
});

describe('secondsFromEnv', () => {
    test('reads the value of the variable', () => {
        setEnv('TEST_SECONDS', '42');
        expect(secondsFromEnv('TEST_SECONDS', 10)).toBe(42);
    });

    test('falls back when the variable is missing', () => {
        setEnv('TEST_SECONDS', undefined);
        expect(secondsFromEnv('TEST_SECONDS', 10)).toBe(10);
    });

    test('falls back when the value is not a number', () => {
        setEnv('TEST_SECONDS', 'abc');
        expect(secondsFromEnv('TEST_SECONDS', 10)).toBe(10);
    });

    test('falls back when the value is zero or negative', () => {
        setEnv('TEST_SECONDS', '0');
        expect(secondsFromEnv('TEST_SECONDS', 10)).toBe(10);
        setEnv('TEST_SECONDS', '-5');
        expect(secondsFromEnv('TEST_SECONDS', 10)).toBe(10);
    });
});

describe('timeoutFromEnv', () => {
    test('converts the seconds into milliseconds', () => {
        setEnv('TEST_TIMEOUT', '60');
        expect(timeoutFromEnv('TEST_TIMEOUT', 10)).toBe(60_000);
    });

    test('converts the fallback into milliseconds', () => {
        setEnv('TEST_TIMEOUT', undefined);
        expect(timeoutFromEnv('TEST_TIMEOUT', 30)).toBe(30_000);
    });
});

describe('intFromEnv', () => {
    test('reads the value of the variable', () => {
        setEnv('TEST_INT', '7');
        expect(intFromEnv('TEST_INT', 3)).toBe(7);
    });

    test('falls back when the variable is missing or invalid', () => {
        setEnv('TEST_INT', undefined);
        expect(intFromEnv('TEST_INT', 3)).toBe(3);
        setEnv('TEST_INT', 'not-a-number');
        expect(intFromEnv('TEST_INT', 3)).toBe(3);
    });
});
