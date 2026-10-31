import { describe, expect, test } from 'bun:test';
import { validateArgs, validateResult } from './schema';

describe('validateArgs', () => {
    test('accepts valid arguments', () => {
        const schema = {
            type: 'object',
            properties: { name: { type: 'string' }, age: { type: 'integer' } },
            required: ['name']
        };
        expect(validateArgs({ name: 'ada', age: 36 }, schema)).toEqual([]);
    });

    test('reports missing required fields', () => {
        const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
        expect(validateArgs({}, schema)).toContain("missing required field 'name'");
    });

    test('reports type mismatches', () => {
        const schema = { type: 'object', properties: { name: { type: 'string' } } };
        expect(validateArgs({ name: 42 }, schema)).toContain("field 'name' expected type string, got number");
    });

    test('accepts an integer where a number is expected', () => {
        const schema = { type: 'object', properties: { score: { type: 'number' } } };
        expect(validateArgs({ score: 7 }, schema)).toEqual([]);
    });

    test('validates enum values', () => {
        const schema = { type: 'object', properties: { mode: { enum: ['a', 'b'] } } };
        expect(validateArgs({ mode: 'c' }, schema)[0]).toContain("must be one of");
    });

    test('validates string, number and array constraints', () => {
        const schema = {
            type: 'object',
            properties: {
                text: { type: 'string', minLength: 3, maxLength: 5 },
                count: { type: 'integer', minimum: 1, maximum: 10 },
                items: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true }
            }
        };
        expect(validateArgs({ text: 'ab' }, schema)[0]).toContain('at least 3 characters');
        expect(validateArgs({ count: 11 }, schema)[0]).toContain('must be <= 10');
        expect(validateArgs({ items: ['a', 'a'] }, schema)[0]).toContain('unique items');
    });

    test('validates nested objects and arrays', () => {
        const schema = {
            type: 'object',
            properties: {
                user: {
                    type: 'object',
                    properties: { email: { type: 'string' } },
                    required: ['email']
                },
                tags: { type: 'array', items: { type: 'string' } }
            }
        };
        const errors = validateArgs({ user: {}, tags: ['ok', 5] }, schema);
        expect(errors.some(e => e.includes("missing required field 'user.email'"))).toBe(true);
        expect(errors.some(e => e.includes("field 'tags[1]'"))).toBe(true);
    });

    test('resolves internal $ref', () => {
        const schema = {
            type: 'object',
            definitions: {
                name: { type: 'string', minLength: 2 }
            },
            properties: {
                first: { $ref: '#/definitions/name' },
                second: { $ref: '#/definitions/name' }
            }
        };
        expect(validateArgs({ first: 'ab' }, schema)).toEqual([]);
        expect(validateArgs({ first: 'a' }, schema)[0]).toContain('at least 2 characters');
        expect(validateArgs({ second: 'a' }, schema)[0]).toContain('at least 2 characters');
    });

    test('supports anyOf and oneOf', () => {
        const schema = {
            type: 'object',
            properties: {
                value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
                unique: { oneOf: [{ type: 'string' }, { type: 'number' }] }
            }
        };
        expect(validateArgs({ value: 'a', unique: 'b' }, schema)).toEqual([]);
        expect(validateArgs({ value: true }, schema)[0]).toContain('does not match any of the allowed schemas');
    });

    test('rejects additional properties when they are not allowed', () => {
        const schema = {
            type: 'object',
            properties: { a: { type: 'string' } },
            additionalProperties: false
        };
        expect(validateArgs({ a: 'x', b: 'y' }, schema)[0]).toContain("field 'b' is not an allowed property");
    });

    test('does not crash on cyclic references', () => {
        const schema: any = { type: 'object', properties: { child: { $ref: '#' } } };
        expect(() => validateArgs({ child: {} }, schema)).not.toThrow();
    });

    test('ignores schemas without type information', () => {
        expect(validateArgs({ anything: 1 }, { description: 'free form' })).toEqual([]);
    });
});

describe('validateResult', () => {
    test('validates structured content against the output schema', () => {
        const schema = { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] };
        expect(validateResult({ structuredContent: { count: 1 } }, schema)).toEqual([]);
        expect(validateResult({ structuredContent: { count: 'x' } }, schema)[0]).toContain("field 'count' expected type number");
    });

    test('falls back to parsing text content as JSON', () => {
        const schema = { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] };
        expect(validateResult({ content: [{ type: 'text', text: '{"count":2}' }] }, schema)).toEqual([]);
    });

    test('returns no errors when there is nothing structured to validate', () => {
        expect(validateResult({ content: [{ type: 'text', text: 'plain' }] }, { type: 'object' })).toEqual([]);
    });
});
