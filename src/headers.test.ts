import { describe, expect, test } from 'bun:test';
import { buildParamHeaders, encodeHeaderValue, scanHeaderDeclarations } from './headers';

describe('scanHeaderDeclarations', () => {
    test('finds the annotations of the top level properties', () => {
        const scan = scanHeaderDeclarations({
            type: 'object',
            properties: {
                region: { type: 'string', 'x-mcp-header': 'Region' },
                quantity: { type: 'integer', 'x-mcp-header': 'Quantity' }
            }
        });
        expect(scan.errors).toEqual([]);
        expect(scan.declarations.map(d => d.name)).toEqual(['Region', 'Quantity']);
        expect(scan.declarations[0]?.path).toEqual(['region']);
    });

    test('finds the annotations of nested properties', () => {
        const scan = scanHeaderDeclarations({
            type: 'object',
            properties: {
                order: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', 'x-mcp-header': 'Order-Id' }
                    }
                }
            }
        });
        expect(scan.errors).toEqual([]);
        expect(scan.declarations[0]?.path).toEqual(['order', 'id']);
    });

    test('rejects an invalid header name', () => {
        const scan = scanHeaderDeclarations({
            type: 'object',
            properties: { region: { type: 'string', 'x-mcp-header': 'Invalid Header' } }
        });
        expect(scan.declarations).toEqual([]);
        expect(scan.errors[0]).toContain('invalid header name');
    });

    test('rejects duplicated header names, ignoring the case', () => {
        const scan = scanHeaderDeclarations({
            type: 'object',
            properties: {
                a: { type: 'string', 'x-mcp-header': 'Region' },
                b: { type: 'string', 'x-mcp-header': 'region' }
            }
        });
        expect(scan.errors[0]).toContain('declared more than once');
    });

    test('rejects a non primitive parameter', () => {
        const scan = scanHeaderDeclarations({
            type: 'object',
            properties: { region: { type: 'object', 'x-mcp-header': 'Region' } }
        });
        expect(scan.errors[0]).toContain('only primitive types are allowed');
    });

    test('rejects an empty annotation', () => {
        const scan = scanHeaderDeclarations({
            type: 'object',
            properties: { region: { type: 'string', 'x-mcp-header': '' } }
        });
        expect(scan.errors[0]).toContain('empty or non-string');
    });

    test('ignores schemas without annotations', () => {
        const scan = scanHeaderDeclarations({ type: 'object', properties: { region: { type: 'string' } } });
        expect(scan.declarations).toEqual([]);
        expect(scan.errors).toEqual([]);
    });

    test('does not crash with a malformed schema', () => {
        expect(() => scanHeaderDeclarations(null)).not.toThrow();
        expect(() => scanHeaderDeclarations({ properties: 'nope' })).not.toThrow();
    });
});

describe('encodeHeaderValue', () => {
    test('keeps plain printable ASCII values untouched', () => {
        expect(encodeHeaderValue('emea')).toBe('emea');
        expect(encodeHeaderValue('a-b_c.d')).toBe('a-b_c.d');
    });

    test('base64 encodes values with leading or trailing whitespace', () => {
        const encoded = encodeHeaderValue(' emea ');
        expect(encoded.startsWith('=?base64?')).toBe(true);
        expect(encoded.endsWith('?=')).toBe(true);
    });

    test('base64 encodes values with non ASCII characters', () => {
        const encoded = encodeHeaderValue('España');
        expect(encoded.startsWith('=?base64?')).toBe(true);
    });

    test('base64 encodes values that collide with the sentinel', () => {
        const encoded = encodeHeaderValue('=?base64?abc?=');
        expect(encoded.startsWith('=?base64?')).toBe(true);
        expect(encoded).not.toBe('=?base64?abc?=');
    });
});

describe('buildParamHeaders', () => {
    const declarations = scanHeaderDeclarations({
        type: 'object',
        properties: {
            region: { type: 'string', 'x-mcp-header': 'Region' },
            quantity: { type: 'integer', 'x-mcp-header': 'Quantity' },
            active: { type: 'boolean', 'x-mcp-header': 'Active' }
        }
    }).declarations;

    test('builds the Mcp-Param headers of the annotated arguments', () => {
        const headers = buildParamHeaders(declarations, { region: 'emea', quantity: 42, active: true });
        expect(headers).toEqual({
            'Mcp-Param-Region': 'emea',
            'Mcp-Param-Quantity': '42',
            'Mcp-Param-Active': 'true'
        });
    });

    test('omits the headers of the arguments that are absent or null', () => {
        const headers = buildParamHeaders(declarations, { region: null, quantity: 7 });
        expect(headers).toEqual({ 'Mcp-Param-Quantity': '7' });
    });

    test('reads the values of nested properties', () => {
        const nested = scanHeaderDeclarations({
            type: 'object',
            properties: {
                order: {
                    type: 'object',
                    properties: { id: { type: 'string', 'x-mcp-header': 'Order-Id' } }
                }
            }
        }).declarations;
        expect(buildParamHeaders(nested, { order: { id: 'A-1' } })).toEqual({ 'Mcp-Param-Order-Id': 'A-1' });
    });

    test('ignores the values whose type does not match the schema', () => {
        expect(buildParamHeaders(declarations, { quantity: 'not-a-number' })).toEqual({});
    });
});
