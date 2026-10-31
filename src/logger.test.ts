import { describe, expect, test } from 'bun:test';
import { REDACTED, redact } from './logger';

describe('redact', () => {
    test('hides the values of the sensitive fields', () => {
        const result = redact({
            authorization: 'Bearer abc',
            apiKey: 'sk-123',
            client_secret: 'shhh',
            password: 'hunter2',
            access_token: 'at-1'
        }) as Record<string, unknown>;

        for (const value of Object.values(result)) {
            expect(value).toBe(REDACTED);
        }
    });

    test('hides the sensitive fields of nested objects and arrays', () => {
        const result = redact({
            headers: { Authorization: 'Bearer abc' },
            items: [{ token: 't-1' }, { safe: 'value' }]
        }) as any;

        expect(result.headers.Authorization).toBe(REDACTED);
        expect(result.items[0].token).toBe(REDACTED);
        expect(result.items[1].safe).toBe('value');
    });

    test('keeps the values that are not sensitive', () => {
        expect(redact({ server: 'filesystem', count: 3 })).toEqual({ server: 'filesystem', count: 3 });
    });

    test('truncates very long strings', () => {
        const result = redact({ description: 'x'.repeat(5000) }) as any;
        expect(result.description.length).toBeLessThan(5000);
        expect(result.description).toContain('[truncated');
    });

    test('serializes the errors', () => {
        const result = redact({ error: new Error('boom') }) as any;
        expect(result.error.name).toBe('Error');
        expect(result.error.message).toBe('boom');
    });

    test('does not crash with circular structures', () => {
        const circular: any = { name: 'root' };
        circular.self = circular;
        expect(() => redact(circular)).not.toThrow();
    });
});
