import { describe, expect, test } from 'bun:test';
import { reconstructHistory, extractMcpResultText, extractResourceText, summarizeToolArgs, toIsoString, buildSystemMessage } from './conversation';

describe('toIsoString', () => {
    test('formats the date with the local offset', () => {
        const date = new Date(2026, 0, 2, 3, 4, 5);
        const formatted = toIsoString(date);
        expect(formatted).toMatch(/^2026-01-02T03:04:05[+-]\d{2}:\d{2}$/);
    });

    test('pads the hours, minutes and seconds', () => {
        const date = new Date(2026, 10, 30, 9, 8, 7);
        const formatted = toIsoString(date);
        expect(formatted).toContain('T09:08:07');
    });
});

describe('buildSystemMessage', () => {
    const now = new Date(2026, 0, 2, 3, 4, 5);

    test('includes the instructions, the user and the date', () => {
        const message = buildSystemMessage('You are an assistant\n', '555@c.us', now);
        expect(message).toContain('You are an assistant');
        expect(message).toContain('The current user is 555@c.us');
        expect(message).toContain('The current date in ISO String format is ' + toIsoString(now));
    });

    test('warns the model about the identifiers', () => {
        const message = buildSystemMessage('Instructions', '555@c.us', now);
        expect(message).toContain('NEVER show the ID field to the user as it is sensitive information');
    });
});

describe('reconstructHistory', () => {
    test('rebuilds a plain user message', () => {
        const messages = reconstructHistory([{ role: 'user', text_content: 'hello' }]);
        expect(messages).toEqual([{ role: 'user', content: 'hello' }]);
    });

    test('skips the entries without content', () => {
        const messages = reconstructHistory([
            { role: 'user', text_content: '' },
            { role: 'user', text_content: null },
            { role: 'user', text_content: 'kept' }
        ]);
        expect(messages).toHaveLength(1);
        expect(messages[0].content).toBe('kept');
    });

    test('restores the tool calls of an assistant message', () => {
        const toolCalls = [{ id: 'call-1', type: 'function', function: { name: 'call_tool', arguments: '{}' } }];
        const messages = reconstructHistory([
            { role: 'assistant', text_content: '', function_name: JSON.stringify(toolCalls) }
        ]);
        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe('assistant');
        expect(messages[0].tool_calls).toEqual(toolCalls);
    });

    test('keeps the text of an assistant message that also invoked tools', () => {
        const toolCalls = [{ id: 'call-1', type: 'function', function: { name: 'call_tool', arguments: '{}' } }];
        const messages = reconstructHistory([
            { role: 'assistant', text_content: 'thinking', function_name: JSON.stringify(toolCalls) }
        ]);
        expect(messages[0].content).toBe('thinking');
        expect(messages[0].tool_calls).toHaveLength(1);
    });

    test('falls back to the text when the serialized tool calls are malformed', () => {
        const messages = reconstructHistory([
            { role: 'assistant', text_content: 'plain answer', function_name: '{not json' }
        ]);
        expect(messages).toEqual([{ role: 'assistant', content: 'plain answer' }]);
    });

    test('ignores a serialized value that is not an array of tool calls', () => {
        const messages = reconstructHistory([
            { role: 'assistant', text_content: 'plain answer', function_name: '"just a string"' }
        ]);
        expect(messages[0].tool_calls).toBeUndefined();
        expect(messages[0].content).toBe('plain answer');
    });

    test('rebuilds a tool result with its call id', () => {
        const messages = reconstructHistory([
            { role: 'tool', text_content: 'the result', tool_call_id: 'call-1', function_name: 'call_tool' }
        ]);
        expect(messages[0]).toEqual({
            role: 'tool',
            content: 'the result',
            tool_call_id: 'call-1',
            name: 'call_tool'
        });
    });

    test('keeps the order of the entries', () => {
        const messages = reconstructHistory([
            { role: 'user', text_content: 'one' },
            { role: 'assistant', text_content: 'two' },
            { role: 'user', text_content: 'three' }
        ]);
        expect(messages.map((m: any) => m.content)).toEqual(['one', 'two', 'three']);
    });
});

describe('extractMcpResultText', () => {
    test('joins the text blocks', () => {
        const text = extractMcpResultText({
            content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }]
        });
        expect(text).toBe('first\nsecond');
    });

    test('describes the media blocks that cannot be shown', () => {
        const text = extractMcpResultText({
            content: [{ type: 'image', data: 'base64' }, { type: 'audio', data: 'base64' }]
        });
        expect(text).toContain('[image content not displayed in text chat]');
        expect(text).toContain('[audio content not displayed in text chat]');
    });

    test('describes an embedded resource', () => {
        const text = extractMcpResultText({
            content: [{ type: 'resource', resource: { uri: 'file:///a.txt' } }]
        });
        expect(text).toContain('[Resource: file:///a.txt]');
    });

    test('uses an unknown uri when the resource has none', () => {
        const text = extractMcpResultText({ content: [{ type: 'resource', resource: {} }] });
        expect(text).toContain('[Resource: unknown]');
    });

    test('falls back to the structured content', () => {
        const text = extractMcpResultText({ structuredContent: { ok: true } });
        expect(text).toBe('{"ok":true}');
    });

    test('falls back to the serialized result', () => {
        const text = extractMcpResultText({ content: [] });
        expect(text).toBe('{"content":[]}');
    });
});

describe('extractResourceText', () => {
    test('reads the text of the contents', () => {
        const text = extractResourceText({
            contents: [{ uri: 'file:///a.txt', mimeType: 'text/plain', text: 'hello' }]
        });
        expect(text).toContain('[file:///a.txt (text/plain)]');
        expect(text).toContain('hello');
    });

    test('describes a binary content without dumping it', () => {
        const text = extractResourceText({
            contents: [{ uri: 'file:///a.bin', blob: 'x'.repeat(500) }]
        });
        expect(text).toContain('[binary content: 500 base64 chars]');
        expect(text).not.toContain('xxxx');
    });

    test('falls back to the serialized result when there are no contents', () => {
        expect(extractResourceText({ foo: 'bar' })).toBe('{"foo":"bar"}');
    });
});

describe('summarizeToolArgs', () => {
    test('formats the arguments as indented JSON', () => {
        expect(summarizeToolArgs({ path: '/tmp/a' })).toContain('"path": "/tmp/a"');
    });

    test('redacts the secrets', () => {
        const summary = summarizeToolArgs({ api_key: 'super-secret', password: 'hunter2', path: '/tmp/a' });
        expect(summary).not.toContain('super-secret');
        expect(summary).not.toContain('hunter2');
        expect(summary).toContain('[redacted]');
        expect(summary).toContain('/tmp/a');
    });

    test('truncates very long arguments', () => {
        const summary = summarizeToolArgs({ data: 'x'.repeat(5000) });
        expect(summary.length).toBeLessThan(1400);
        expect(summary).toContain('... [truncated]');
    });

    test('does not throw with a circular structure', () => {
        const circular: any = { name: 'x' };
        circular.self = circular;
        expect(summarizeToolArgs(circular)).toBe('(arguments could not be displayed)');
    });
});
