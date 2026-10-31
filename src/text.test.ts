import { describe, expect, test } from 'bun:test';
import { estimateMessageTokens, estimateTokens, extractMediaUrls, stripMediaUrls, truncateMessages, truncateResult } from './text';

describe('truncateResult', () => {
    test('returns short results unchanged', () => {
        expect(truncateResult('hello', 100)).toBe('hello');
    });

    test('does not reformat results that already fit', () => {
        expect(truncateResult('{"a":1}', 100)).toBe('{"a":1}');
    });

    test('adds a structural summary when truncating an array', () => {
        const payload = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ index: i, value: 'x'.repeat(20) })));
        const result = truncateResult(payload, 300);
        expect(result).toContain('Array[200 items]');
    });

    test('adds a structural summary when truncating an object', () => {
        const payload = JSON.stringify({ alpha: 'a'.repeat(200), beta: 'b'.repeat(200) });
        const result = truncateResult(payload, 300);
        expect(result).toContain('Object{');
    });

    test('truncates plain text at a word boundary', () => {
        const result = truncateResult('word '.repeat(100), 50);
        expect(result.endsWith('...')).toBe(true);
        expect(result.length).toBeLessThanOrEqual(53);
    });
});

describe('estimateTokens', () => {
    test('counts latin text as ~4 chars per token', () => {
        expect(estimateTokens('abcd')).toBe(1);
        expect(estimateTokens('a'.repeat(40))).toBe(10);
    });

    test('counts CJK characters as one token each', () => {
        // 8 CJK characters must not be estimated as 8/4 tokens
        expect(estimateTokens('中文字符测试内容')).toBe(8);
    });

    test('handles empty input', () => {
        expect(estimateTokens('')).toBe(0);
    });
});

describe('estimateMessageTokens', () => {
    test('counts the tool calls of an assistant message', () => {
        const message = {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call-1', function: { name: 'execute_code', arguments: JSON.stringify({ code: 'x'.repeat(400) }) } }]
        };
        expect(estimateMessageTokens(message)).toBeGreaterThan(90);
    });

    test('counts the text and the tool calls of the same message', () => {
        const withText = estimateMessageTokens({ role: 'assistant', content: 'a'.repeat(40) });
        const withTextAndCalls = estimateMessageTokens({
            role: 'assistant',
            content: 'a'.repeat(40),
            tool_calls: [{ id: 'call-1', function: { name: 'x', arguments: 'b'.repeat(40) } }]
        });
        expect(withTextAndCalls).toBeGreaterThan(withText);
    });
});

describe('truncateMessages', () => {
    test('keeps every message when under the budget', () => {
        const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];
        expect(truncateMessages(messages, 1000)).toEqual(messages);
    });

    test('always keeps the system message and drops the oldest entries', () => {
        const messages = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'a'.repeat(400) },
            { role: 'assistant', content: 'b'.repeat(400) },
            { role: 'user', content: 'c'.repeat(400) }
        ];
        const result = truncateMessages(messages, 120);
        expect(result[0].role).toBe('system');
        expect(result.length).toBeLessThan(messages.length);
        expect(result[result.length - 1].content).toContain('c');
    });

    test('never drops a tool result referenced by a pending tool call', () => {
        const messages = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'a'.repeat(400) },
            { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', function: { name: 'x', arguments: '{}' } }] },
            { role: 'tool', content: 'result', tool_call_id: 'call-1' }
        ];
        const result = truncateMessages(messages, 20);
        expect(result.some((m: any) => m.role === 'tool' && m.tool_call_id === 'call-1')).toBe(true);
    });
});

describe('media urls', () => {
    test('keeps regular links in the text', () => {
        const text = 'See https://example.com/docs for details';
        expect(extractMediaUrls(text)).toEqual([]);
        expect(stripMediaUrls(text)).toBe(text);
    });

    test('extracts only urls that point to a media file', () => {
        const text = 'image https://example.com/a.png and doc https://example.com/page';
        expect(extractMediaUrls(text)).toEqual(['https://example.com/a.png']);
        expect(stripMediaUrls(text)).toBe('image and doc https://example.com/page');
    });

    test('supports query strings and common extensions', () => {
        expect(extractMediaUrls('https://cdn.test/v.mp4?token=abc')).toEqual(['https://cdn.test/v.mp4?token=abc']);
        expect(extractMediaUrls('https://cdn.test/v.PDF')).toEqual(['https://cdn.test/v.PDF']);
    });
});
