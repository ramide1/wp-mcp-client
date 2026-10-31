import { describe, expect, test } from 'bun:test';
import {
    isRetryableError,
    withRetries,
    extractAssistantMessage,
    callChatCompletion,
    transcribeAudio
} from './api';

/** Build a fetch mock that answers with the given responses, in order. */
const mockFetch = (responses: Array<{ status?: number; body?: any; text?: string }>): {
    fetchImpl: typeof fetch;
    calls: Array<{ url: string; init?: RequestInit }>;
} => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let index = 0;
    const fetchImpl = (async (input: any, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        const response = responses[index++] ?? { status: 200, body: {} };
        const body = response.text !== undefined ? response.text : JSON.stringify(response.body ?? {});
        return new Response(body, { status: response.status ?? 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
};

describe('isRetryableError', () => {
    test('detects the transient failures', () => {
        expect(isRetryableError(new Error('Rate limit reached for model'))).toBe(true);
        expect(isRetryableError(new Error('HTTP 502'))).toBe(true);
        expect(isRetryableError(new Error('HTTP 503'))).toBe(true);
        expect(isRetryableError(new Error('HTTP 504'))).toBe(true);
        expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
        expect(isRetryableError(new Error('ETIMEDOUT'))).toBe(true);
        expect(isRetryableError(new Error('network error'))).toBe(true);
        expect(isRetryableError(new Error('request timeout'))).toBe(true);
    });

    test('does not retry the permanent failures', () => {
        expect(isRetryableError(new Error('Invalid arguments'))).toBe(false);
        expect(isRetryableError(new Error('HTTP 401'))).toBe(false);
        expect(isRetryableError(new Error('HTTP 400'))).toBe(false);
        expect(isRetryableError(new Error('Tool not found'))).toBe(false);
    });

    test('handles the values that are not errors', () => {
        expect(isRetryableError('rate_limit')).toBe(true);
        expect(isRetryableError(undefined)).toBe(false);
        expect(isRetryableError(null)).toBe(false);
    });
});

describe('withRetries', () => {
    test('returns the result of the first successful attempt', async () => {
        let calls = 0;
        const result = await withRetries(async () => {
            calls++;
            return 'ok';
        }, { attempts: 3, delayMs: 0 });
        expect(result).toBe('ok');
        expect(calls).toBe(1);
    });

    test('retries the transient failures until it succeeds', async () => {
        let calls = 0;
        const result = await withRetries(async () => {
            calls++;
            if (calls < 3) throw new Error('HTTP 503');
            return 'recovered';
        }, { attempts: 5, delayMs: 0 });
        expect(result).toBe('recovered');
        expect(calls).toBe(3);
    });

    test('does not retry a permanent failure', async () => {
        let calls = 0;
        await expect(withRetries(async () => {
            calls++;
            throw new Error('Invalid arguments');
        }, { attempts: 5, delayMs: 0 })).rejects.toThrow('Invalid arguments');
        expect(calls).toBe(1);
    });

    test('throws the last error when every attempt fails', async () => {
        let calls = 0;
        await expect(withRetries(async () => {
            calls++;
            throw new Error(`HTTP 503 attempt ${calls}`);
        }, { attempts: 3, delayMs: 0 })).rejects.toThrow('HTTP 503 attempt 3');
        expect(calls).toBe(3);
    });

    test('always tries at least once', async () => {
        let calls = 0;
        await expect(withRetries(async () => {
            calls++;
            throw new Error('boom');
        }, { attempts: 0, delayMs: 0 })).rejects.toThrow('boom');
        expect(calls).toBe(1);
    });
});

describe('extractAssistantMessage', () => {
    test('returns the message, the tool calls and the content', () => {
        const result = extractAssistantMessage({
            choices: [{ message: { role: 'assistant', content: 'hello' } }]
        });
        expect(result.content).toBe('hello');
        expect(result.toolCalls).toEqual([]);
        expect(result.message.role).toBe('assistant');
    });

    test('returns the tool calls requested by the model', () => {
        const toolCalls = [{ id: 'call-1', function: { name: 'call_tool', arguments: '{}' } }];
        const result = extractAssistantMessage({
            choices: [{ message: { role: 'assistant', content: null, tool_calls: toolCalls } }]
        });
        expect(result.toolCalls).toEqual(toolCalls);
        expect(result.content).toBeNull();
    });

    test('rejects a response without choices', () => {
        expect(() => extractAssistantMessage({ error: { message: 'nope' } }))
            .toThrow('Failed response. Please try again in a few seconds');
        expect(() => extractAssistantMessage(null))
            .toThrow('Failed response. Please try again in a few seconds');
    });

    test('rejects a choice without a message', () => {
        expect(() => extractAssistantMessage({ choices: [{}] }))
            .toThrow('Failed response. Please try again in a few seconds');
    });
});

describe('callChatCompletion', () => {
    const request = {
        url: 'https://api.example.com/v1/chat/completions',
        apiKey: 'secret',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        maxTokens: 2000
    };

    test('sends the expected request', async () => {
        const { fetchImpl, calls } = mockFetch([{ body: { choices: [{ message: { content: 'hello' } }] } }]);
        const data = await callChatCompletion(request, fetchImpl);
        expect(data.choices[0].message.content).toBe('hello');

        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe(request.url);
        expect(calls[0]!.init?.method).toBe('POST');
        const headers = calls[0]!.init?.headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer secret');
        expect(headers['Content-Type']).toBe('application/json');

        const body = JSON.parse(String(calls[0]!.init?.body));
        expect(body.model).toBe('gpt-4o');
        expect(body.tool_choice).toBe('auto');
        expect(body.max_completion_tokens).toBe(2000);
        expect(body.messages).toEqual(request.messages);
    });

    test('reports the HTTP error with the body of the response', async () => {
        const { fetchImpl } = mockFetch([{ status: 500, text: 'internal error' }]);
        await expect(callChatCompletion(request, fetchImpl)).rejects.toThrow('HTTP 500: internal error');
    });

    test('reports the rate limit of the API', async () => {
        const { fetchImpl } = mockFetch([{
            body: { error: { message: 'Rate limit reached for model gpt-4o' } }
        }]);
        await expect(callChatCompletion(request, fetchImpl))
            .rejects.toThrow('Rate limit reached for model gpt-4o');
    });
});

describe('transcribeAudio', () => {
    const request = {
        url: 'https://api.example.com/v1/audio/transcriptions',
        apiKey: 'secret',
        model: 'whisper-1',
        language: 'en',
        mimeType: 'audio/mp3',
        data: 'BASE64',
        fileName: 'audio.mp3'
    };

    test('transcribes the audio and returns the text', async () => {
        const { fetchImpl, calls } = mockFetch([
            { body: 'blob' },
            { body: { text: 'hello there' } }
        ]);
        const text = await transcribeAudio(request, fetchImpl);
        expect(text).toBe('hello there');

        expect(calls).toHaveLength(2);
        expect(calls[0]!.url).toBe('data:audio/mp3;base64,BASE64');
        expect(calls[1]!.url).toBe(request.url);
        const headers = calls[1]!.init?.headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer secret');
    });

    test('reports a failure while converting the audio', async () => {
        const { fetchImpl } = mockFetch([{ status: 404 }]);
        await expect(transcribeAudio(request, fetchImpl)).rejects.toThrow('Failed response when converting audio');
    });

    test('reports the HTTP error of the transcription API', async () => {
        const { fetchImpl } = mockFetch([{ body: 'blob' }, { status: 429 }]);
        await expect(transcribeAudio(request, fetchImpl)).rejects.toThrow('Audio API HTTP 429');
    });

    test('reports a transcription without text', async () => {
        const { fetchImpl } = mockFetch([{ body: 'blob' }, { body: { text: '' } }]);
        await expect(transcribeAudio(request, fetchImpl)).rejects.toThrow('Failed response when transcribing audio');
    });
});
