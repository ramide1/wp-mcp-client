/**
 * Minimal client of the OpenAI API: retries, chat completions and audio
 * transcription.
 *
 * It is kept in a dedicated module (instead of `main.ts`) so the retry policy
 * and the request/response handling can be unit tested without calling the
 * real API.
 */

/** Error patterns that are worth retrying (transient failures). */
const RETRYABLE_ERROR_PATTERNS = [
    'Rate limit reached',
    'rate_limit',
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'network',
    'timeout',
    '502',
    '503',
    '504'
];

/** Options of the retry policy. */
export interface RetryOptions {
    /** Maximum number of attempts (the first call counts as one). */
    attempts: number;
    /** Delay between two attempts, in milliseconds. */
    delayMs: number;
}

/**
 * True when the error looks transient and the call is worth retrying.
 * Permanent errors (invalid arguments, authentication failures, ...) are
 * rethrown immediately.
 */
export const isRetryableError = (error: unknown): boolean => {
    const message = String((error as { message?: unknown })?.message ?? error ?? '').toLowerCase();
    return RETRYABLE_ERROR_PATTERNS.some(pattern => message.includes(pattern.toLowerCase()));
};

/**
 * Run an operation, retrying it while the error is transient.
 *
 * @throws The last error when every attempt failed.
 */
export const withRetries = async <T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> => {
    const maxAttempts = Math.max(1, options.attempts);
    let attempts = 0;
    let lastError: unknown = null;
    while (attempts < maxAttempts) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            attempts++;
            // Don't retry permanent errors (invalid args, auth failures, etc.)
            if (!isRetryableError(error)) throw error;
            if (attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, Math.max(0, options.delayMs)));
            }
        }
    }
    throw lastError ?? new Error('Function failed after retries');
};

/** Request of a chat completion. */
export interface ChatCompletionRequest {
    /** URL of the chat completions endpoint. */
    url: string;
    /** API key used as a bearer token. */
    apiKey: string;
    /** Name of the model. */
    model: string;
    /** Messages of the conversation. */
    messages: any[];
    /** Tools exposed to the model. */
    tools: any[];
    /** Maximum number of tokens of the answer. */
    maxTokens: number;
}

/** The assistant message of a chat completion. */
export interface AssistantMessage {
    /** The raw message returned by the API. */
    message: any;
    /** The tool calls requested by the model (empty when it answered directly). */
    toolCalls: any[];
    /** The text of the answer, or null when the model only requested tools. */
    content: string | null;
}

/**
 * Extract the assistant message of a chat completion.
 *
 * @throws Error when the response has no usable message.
 */
export const extractAssistantMessage = (data: any): AssistantMessage => {
    if (!data || data.error || !data.choices) {
        throw new Error('Failed response. Please try again in a few seconds');
    }
    const message = data.choices[0]?.message ?? null;
    if (!message) {
        throw new Error('Failed response. Please try again in a few seconds');
    }
    const toolCalls = message.tool_calls ?? [];
    return { message, toolCalls, content: message.content ?? null };
};

/**
 * Call the chat completions endpoint.
 *
 * @returns The raw JSON of the response.
 */
export const callChatCompletion = async (
    request: ChatCompletionRequest,
    fetchImpl: typeof fetch = fetch
): Promise<any> => {
    const response = await fetchImpl(request.url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + request.apiKey
        },
        body: JSON.stringify({
            model: request.model,
            messages: request.messages,
            tools: request.tools,
            tool_choice: 'auto',
            max_completion_tokens: request.maxTokens
        })
    });

    if (!response.ok) {
        let errorBody = '';
        try { errorBody = await response.text(); } catch { }
        const detail = errorBody ? `: ${errorBody.substring(0, 200)}` : '';
        throw new Error(`HTTP ${response.status}${detail}`);
    }

    const data = await response.json() as any;
    if (!data || (data.error && data.error.message && data.error.message.startsWith('Rate limit reached for model'))) {
        throw new Error(data?.error?.message ?? 'Rate limit reached');
    }
    return data;
};

/** Request of an audio transcription. */
export interface AudioTranscriptionRequest {
    /** URL of the audio endpoint. */
    url: string;
    /** API key used as a bearer token. */
    apiKey: string;
    /** Name of the transcription model. */
    model: string;
    /** Language of the audio. */
    language: string;
    /** MIME type of the audio. */
    mimeType: string;
    /** Base64 payload of the audio. */
    data: string;
    /** File name advertised to the API (optional). */
    fileName?: string;
}

/**
 * Transcribe an audio message.
 *
 * @returns The transcribed text.
 */
export const transcribeAudio = async (
    request: AudioTranscriptionRequest,
    fetchImpl: typeof fetch = fetch
): Promise<string> => {
    const audioResponse = await fetchImpl('data:' + request.mimeType + ';base64,' + request.data);
    if (!audioResponse.ok) throw new Error('Failed response when converting audio');
    const audioData = await audioResponse.blob();

    const formData: FormData = new FormData();
    if (request.fileName) {
        formData.append('file', audioData, request.fileName);
    } else {
        formData.append('file', audioData);
    }
    formData.append('model', request.model);
    formData.append('language', request.language);
    formData.append('prompt', 'Transcribe the audio');
    formData.append('response_format', 'json');

    const response = await fetchImpl(request.url, {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + request.apiKey
        },
        body: formData
    });
    if (!response.ok) throw new Error(`Audio API HTTP ${response.status}`);

    const parsed = await response.json() as any;
    if (!parsed || !parsed.text || parsed.text === '') {
        throw new Error('Failed response when transcribing audio');
    }
    return parsed.text as string;
};
