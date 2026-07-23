import { Client, LocalAuth, MessageMedia, type Message, type Chat } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { saveHistory, loadHistory, resetHistory, resetAllHistory, closeDatabase } from './db';
import { readFileSync, existsSync } from 'fs';
import { MCPClientManager } from './mcp';
import { SandboxRunner } from './sandbox';
import type { SandboxStep, DirectToolDefinition } from './interface';

const tokenOpenaiApi: string = process.env.TOKEN_OPENAI_API ?? '';
const tokenOpenaiAudioApi: string = process.env.TOKEN_OPENAI_AUDIO_API ?? tokenOpenaiApi;
const urlBaseOpenaiApi: string = process.env.URL_BASE_OPENAI_API ?? 'https://api.openai.com/v1/chat/completions';
const urlBaseOpenaiAudioApi: string = process.env.URL_BASE_OPENAI_AUDIO_API ?? '';
const modelApiAudioOpenai: string = process.env.MODEL_API_AUDIO_OPENAI ?? '';
const audioLanguage: string = process.env.AUDIO_LANGUAGE ?? 'en';
const modelApiOpenai: string = process.env.MODEL_API_OPENAI ?? 'gpt-4o';
const modelSupportsImage: boolean = process.env.MODEL_SUPPORTS_IMAGE === 'true';
const limitTokensOpenai: number = parseInt(process.env.LIMIT_TOKENS_OPENAI ?? '2000');
const limitFetch: number = parseInt(process.env.LIMIT_FETCH ?? '3');
const limitTime: number = parseInt(process.env.LIMIT_TIME ?? '5') * 1000;
const limitTools: number = parseInt(process.env.LIMIT_TOOLS ?? '10');
// Max length for tool results sent back to the LLM to prevent context window overflow
const maxToolResultLength: number = parseInt(process.env.MAX_TOOL_RESULT_LENGTH ?? '8000');
const sandboxTimeoutMs: number = parseInt(process.env.SANDBOX_TIMEOUT ?? '30') * 1000;
const adminUsers: string[] = (process.env.ADMIN_USERS ?? '').split(/,\s*/).map(u => u.trim()).filter(u => u.length > 0);
// Max estimated tokens for the messages array. When exceeded, oldest non-system messages are dropped.
// Default 120k leaves room for system prompt + tools + response in a 128k context window.
const maxContextTokens: number = parseInt(process.env.MAX_CONTEXT_TOKENS ?? '120000');

interface PuppeteerConfig {
    args?: string[];
    headless?: boolean;
    chrome?: {
        skipDownload?: boolean;
    };
    firefox?: {
        skipDownload?: boolean;
    };
    executablePath?: string;
}

const puppeteer: PuppeteerConfig = {
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true
};
const browser: string = process.env.BROWSER ?? '';

if (browser !== '') {
    puppeteer.chrome = {
        skipDownload: true
    };
    puppeteer.firefox = {
        skipDownload: true
    };
    puppeteer.executablePath = browser;
}

const sessions: Map<string, boolean> = new Map<string, boolean>();
const testMode: boolean = process.env.TEST_MODE === 'true';
const mcpClientManager = new MCPClientManager();
const sandboxRunner = new SandboxRunner(mcpClientManager);

// Progressive discovery threshold: if total MCP tools <= this, load directly into LLM tools array.
// If > threshold, use meta-tools (search_tools, get_tool_details, etc.) instead.
// Per MCP best practices: "Implement a threshold as a percentage of the context window. For example, 1%-5%."
// 15 tools is a reasonable default that keeps token usage low while avoiding unnecessary search overhead.
const PROGRESSIVE_DISCOVERY_THRESHOLD: number = parseInt(process.env.MCP_TOOL_THRESHOLD ?? '15');
// Stable tools mode: when true, always use call_tool wrapper (keeps tools array stable for prompt caching)
// When false, uses direct loading when below threshold (current behavior)
// Per MCP best practices: "Append newly discovered definitions after the cache breakpoint rather than re-sorting the tools array"
const STABLE_TOOLS_MODE: boolean = process.env.MCP_STABLE_TOOLS === 'true';
// null = not yet evaluated, true = direct loading, false = progressive discovery
let useDirectLoading: boolean | null = null;
// Promise to protect against race conditions during progressive discovery evaluation
let discoveryEvaluationPromise: Promise<boolean> | null = null;

const client = new Client({
    puppeteer,
    authStrategy: new LocalAuth({
        dataPath: 'auth'
    })
});

const tools: DirectToolDefinition[] = [
    {
        type: 'function',
        function: {
            name: 'clean_current_chat',
            description: 'Clear message history for the current user'
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_tools',
            description: 'Search for available tools across all connected MCP servers. Returns matching tool names and descriptions. Use detailLevel to control output verbosity.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query to find relevant tools'
                    },
                    limit: {
                        type: 'number',
                        description: 'Maximum number of results to return (default: 10)',
                        default: 10
                    },
                    detailLevel: {
                        type: 'string',
                        enum: ['minimal', 'basic', 'full'],
                        description: 'Level of detail: minimal (names only), basic (name+description), full (with schemas). Default: basic',
                        default: 'basic'
                    }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_tool_details',
            description: 'Get detailed information about a specific tool including its input and output schema',
            parameters: {
                type: 'object',
                properties: {
                    serverName: {
                        type: 'string',
                        description: 'Name of the MCP server hosting the tool'
                    },
                    toolName: {
                        type: 'string',
                        description: 'Name of the tool to get details for'
                    }
                },
                required: ['serverName', 'toolName']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'call_tool',
            description: 'Call any MCP tool directly. Use search_tools first to discover available tools, then call them here. This keeps the tool list stable for prompt caching. For chaining multiple tools, use execute_tool_sequence instead.',
            parameters: {
                type: 'object',
                properties: {
                    serverName: {
                        type: 'string',
                        description: 'Name of the MCP server'
                    },
                    toolName: {
                        type: 'string',
                        description: 'Name of the tool to call'
                    },
                    args: {
                        type: 'object',
                        description: 'Arguments to pass to the tool'
                    }
                },
                required: ['serverName', 'toolName']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'execute_tool_sequence',
            description: 'Execute a sequence of MCP tool calls efficiently in a single pass. Use this when you need to call multiple tools that don\'t depend on each other, or when you want to chain tools without passing intermediate results through the conversation. Returns only the final summary.',
            parameters: {
                type: 'object',
                properties: {
                    steps: {
                        type: 'array',
                        description: 'Array of tool calls to execute sequentially',
                        items: {
                            type: 'object',
                            properties: {
                                serverName: {
                                    type: 'string',
                                    description: 'Name of the MCP server'
                                },
                                toolName: {
                                    type: 'string',
                                    description: 'Name of the tool to call'
                                },
                                args: {
                                    type: 'object',
                                    description: 'Arguments to pass to the tool'
                                },
                                saveAs: {
                                    type: 'string',
                                    description: 'Variable name to save result for use in later steps (optional)'
                                },
                                useResultFrom: {
                                    type: 'string',
                                    description: 'Variable name whose result to use as the args for this step (optional)'
                                }
                            },
                            required: ['serverName', 'toolName']
                        }
                    },
                    summary: {
                        type: 'string',
                        description: 'A prompt describing what final summary to produce from the results'
                    }
                },
                required: ['steps', 'summary']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'execute_code',
            description: 'Execute JavaScript code in a sandbox with access to MCP tools. Use the tools object or named functions to call MCP tools. Only the final console output returns to the conversation. Ideal for chaining multiple tools efficiently without passing intermediate results through the LLM.',
            parameters: {
                type: 'object',
                properties: {
                    code: {
                        type: 'string',
                        description: 'JavaScript code to execute. Use tools["server__tool"](args) or tool_alias(args) to call MCP tools. Return a value or use console.log for output.'
                    }
                },
                required: ['code']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_available_servers',
            description: 'List all available MCP servers, their status (connected/disconnected), and how many tools each provides. Use this to discover which servers are available before connecting to them.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    }
];
const adminTools: DirectToolDefinition[] = [
    ...tools,
    {
        type: 'function',
        function: {
            name: 'clean_chat',
            description: 'Clear message history for a specific user (only the following users can do this: ' + adminUsers.join(', ') + ' )',
            parameters: {
                type: 'object',
                properties: {
                    user: {
                        type: 'string',
                        description: 'The user whose message history will be cleared'
                    }
                },
                required: ['user']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'clean_all_chats',
            description: 'Clear message history for all users (only the following users can do this: ' + adminUsers.join(', ') + ' )'
        }
    }
];

const instructionsFile: string = (process.env.INSTRUCTIONS !== undefined) ? process.env.INSTRUCTIONS : 'instructions.txt';
const instructionsFileContent: string = existsSync(instructionsFile) ? readFileSync(instructionsFile, 'utf8') : '';
const instructions: string = ((instructionsFileContent !== '') ? instructionsFileContent : 'You are an assistant') + `
\n\nCONFIRMATION INSTRUCTIONS:\n
- Do NOT use 'functions' unless the client confirms or says EXPLICITLY: 'yes I confirm', 'I want to confirm' or similar\n
- ALWAYS ask: 'Do you want to confirm?' before using the function.\n`;

/**
 * Truncate tool result to prevent context window overflow.
 * Uses structural-aware truncation when possible.
 */
const truncateToolResult = (result: string, maxLength: number = maxToolResultLength): string => {
    if (!result || result.length <= maxLength) return result;
    return truncateResult(result, maxLength);
};

/**
 * Smart truncation that preserves JSON structure when possible.
 * For plain text: truncates at word boundary with ellipsis.
 * For JSON: pretty-prints and truncates with structural hint.
 */
const truncateResult = (result: string, maxLength: number): string => {
    if (!result || result.length <= maxLength) return result;

    // Try to parse as JSON
    try {
        const parsed = JSON.parse(result);
        const pretty = JSON.stringify(parsed, null, 2);

        if (pretty.length <= maxLength) return pretty;

        // For objects/arrays, provide a structural summary when truncating
        if (Array.isArray(parsed)) {
            const summary = `Array[${parsed.length} items]`;
            if (summary.length >= maxLength - 20) {
                return result.substring(0, maxLength) + '...';
            }
            const slice = pretty.substring(0, maxLength - summary.length - 20);
            // Try to find a clean break point (end of a property or item)
            const lastComma = slice.lastIndexOf(',');
            const lastBrace = slice.lastIndexOf('}');
            const lastBracket = slice.lastIndexOf(']');
            const breakPoint = Math.max(lastComma, lastBrace, lastBracket);
            const cleanSlice = breakPoint > maxLength * 0.5 ? slice.substring(0, breakPoint + 1) : slice;
            return cleanSlice + `\n... ${summary}]`;
        }

        if (typeof parsed === 'object' && parsed !== null) {
            const keys = Object.keys(parsed);
            const summary = `Object{${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', ...' : ''}}`;
            if (summary.length >= maxLength - 20) {
                return result.substring(0, maxLength) + '...';
            }
            const slice = pretty.substring(0, maxLength - summary.length - 20);
            const lastComma = slice.lastIndexOf(',');
            const lastBrace = slice.lastIndexOf('}');
            const breakPoint = Math.max(lastComma, lastBrace);
            const cleanSlice = breakPoint > maxLength * 0.5 ? slice.substring(0, breakPoint + 1) : slice;
            return cleanSlice + `\n... ${summary}`;
        }
    } catch {
        // Not JSON, fall through to plain text truncation
    }

    // Plain text: truncate at word boundary
    const slice = result.substring(0, maxLength);
    const lastSpace = slice.lastIndexOf(' ');
    if (lastSpace > maxLength * 0.6) {
        return slice.substring(0, lastSpace) + '...';
    }
    return slice + '...';
};

/**
 * Extract readable text from an MCP tool call result.
 * Handles text, image, audio, and resource content types.
 * Falls back to JSON serialization when no text content is found.
 */
const extractMcpResultText = (result: any): string => {
    let textContent = '';
    if (result && result.content && Array.isArray(result.content)) {
        for (const content of result.content) {
            if (content.type === 'text') {
                textContent += content.text + '\n';
            } else if (content.type === 'image' || content.type === 'audio') {
                textContent += `[${content.type} content not displayed in text chat]\n`;
            } else if (content.type === 'resource') {
                const res = content.resource as any;
                textContent += `[Resource: ${res.uri || 'unknown'}]\n`;
            }
        }
    }
    textContent = textContent.trimEnd();
    if (textContent === '') {
        textContent = JSON.stringify(result);
    }
    return textContent;
};

const cleanCurrentChat = async (user: string) => {
    try {
        if (!resetHistory(user)) throw new Error('Error clearing message history');
        return 'Message history cleared successfully';
    } catch (error: any) {
        return error.message;
    }
};

const cleanChat = async (user: string) => {
    try {
        if (!resetHistory(user)) throw new Error('Error clearing message history for ' + user);
        return 'Message history for ' + user + ' cleared successfully';
    } catch (error: any) {
        return error.message;
    }
};

const cleanAllChats = async () => {
    try {
        if (!resetAllHistory()) throw new Error('Error clearing all message history');
        return 'All message history cleared successfully';
    } catch (error: any) {
        return error.message;
    }
};

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
    '504',
];

const isRetryableError = (error: any): boolean => {
    const msg = String(error?.message ?? error ?? '').toLowerCase();
    return RETRYABLE_ERROR_PATTERNS.some(p => msg.includes(p.toLowerCase()));
};

const functionAttempts = async (functionAttempt: any) => {
    let attempts: number = 0;
    let lastError: any = null;
    while (attempts < limitFetch) {
        try {
            return await functionAttempt();
        } catch (error: any) {
            lastError = error;
            attempts++;
            // Don't retry permanent errors (invalid args, auth failures, etc.)
            if (!isRetryableError(error)) {
                throw error;
            }
            if (attempts < limitFetch) await new Promise(resolve => setTimeout(resolve, limitTime));
        }
    }
    throw lastError ?? new Error('Function failed after retries');
};

const toIsoString = (date: Date) => {
    const tzo: number = -date.getTimezoneOffset(),
        dif: string = tzo >= 0 ? '+' : '-',
        pad: any = function (num: number) {
            return (num < 10 ? '0' : '') + num;
        };

    return date.getFullYear() +
        '-' + pad(date.getMonth() + 1) +
        '-' + pad(date.getDate()) +
        'T' + pad(date.getHours()) +
        ':' + pad(date.getMinutes()) +
        ':' + pad(date.getSeconds()) +
        dif + pad(Math.floor(Math.abs(tzo) / 60)) +
        ':' + pad(Math.abs(tzo) % 60);
}

/**
 * Rough token estimation: ~4 chars per token for English, ~2 for CJK.
 * Good enough for truncation decisions; not for billing.
 */
const estimateTokens = (text: string): number => {
    return Math.ceil(text.length / 4);
};

/**
 * Estimate tokens for a single message object.
 */
const estimateMessageTokens = (msg: any): number => {
    if (typeof msg.content === 'string') {
        return estimateTokens(msg.content);
    }
    if (Array.isArray(msg.content)) {
        return msg.content.reduce((sum: number, part: any) => {
            if (part.type === 'text') return sum + estimateTokens(part.text);
            if (part.type === 'image_url') return sum + 1000; // rough estimate for images
            return sum;
        }, 0);
    }
    // tool_calls in assistant messages
    if (msg.tool_calls) {
        return msg.tool_calls.reduce((sum: number, tc: any) => {
            return sum + estimateTokens(tc.function?.name ?? '') + estimateTokens(tc.function?.arguments ?? '');
        }, 0);
    }
    return 0;
};

/**
 * Truncate messages array to fit within token budget.
 * Keeps system message (index 0) and drops oldest non-system messages first.
 * Never drops tool results that are referenced by pending assistant tool_calls.
 */
const truncateMessages = (messages: any[], maxTokens: number): any[] => {
    let totalTokens = messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
    if (totalTokens <= maxTokens) return messages;

    // Always keep the system message (index 0)
    const systemMsg = messages[0];
    const rest = messages.slice(1);

    // Find the oldest messages we can safely drop
    // We cannot drop a tool result if its tool_call_id is referenced by a newer assistant message
    // Build a set of all tool_call_ids that appear in assistant messages
    const referencedToolCallIds = new Set<string>();
    for (const msg of rest) {
        if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                referencedToolCallIds.add(tc.id);
            }
        }
    }

    // Drop from the front, but skip tool results that are still referenced
    let dropIndex = 0;
    while (dropIndex < rest.length && totalTokens > maxTokens) {
        const msg = rest[dropIndex];
        // Skip if this is a tool result referenced by a later assistant message
        if (msg.role === 'tool' && msg.tool_call_id && referencedToolCallIds.has(msg.tool_call_id)) {
            dropIndex++;
            continue;
        }
        totalTokens -= estimateMessageTokens(msg);
        dropIndex++;
    }

    const truncated = [systemMsg, ...rest.slice(dropIndex)];
    if (dropIndex > 0) {
        console.log(`Truncated messages: dropped ${dropIndex} entries, ~${totalTokens} tokens remaining`);
    }
    return truncated;
};

client.once('ready', async () => {
    console.log('The Bot is ready!');
    try {
        await mcpClientManager.initialize();
        console.log('MCP clients initialized');

        // Defer progressive discovery evaluation to first message (lazy)
        // to avoid connecting all servers on startup
    } catch (error: any) {
        console.error('Failed to initialize MCP clients:', error);
    }
});

client.on('qr', (qr: string) => {
    qrcode.generate(qr, { small: true });
});

client.on('message_create', async (message: Message) => {
    const messageText: string = message.body.trim();
    let media: MessageMedia | null = null;
    if (message.hasMedia) {
        try {
            media = await message.downloadMedia();
        } catch (downloadError: any) {
            console.error('Failed to download media:', downloadError);
            return;
        }
    }
    const currentChat: Chat = await message.getChat();
    if ((!testMode && message.fromMe) || currentChat.isGroup || message.isStatus || (message.to === message.from) || (!media && messageText === '')) return;
    const contact: any = await client.getContactLidAndPhone([message.from]);
    const user: string = contact?.[0]?.pn ?? message.from.split('@')[0];
    const currentSession: number | boolean = sessions.get(user) ?? false;
    try {
        if (currentSession) throw new Error('Responding to previous message. Please wait before sending a new message');
        sessions.set(user, true);
        if (media && !(media.mimetype.startsWith('audio/') || media.mimetype.startsWith('image/'))) throw new Error('Unsupported attachment, only images and audio in flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, or webm format are accepted');
        const userHistory: any[] = loadHistory(user);
        const messages: any[] = [{ role: 'system', content: instructions + 'The current user is ' + user + " \n\n" + 'The current date in ISO String format is ' + toIsoString((new Date())) + "\n\n" + 'NEVER show the ID field to the user as it is sensitive information' + "\n\n" }];
        for (const entry of userHistory) {
            if (entry.role === 'tool') {
                messages.push({ role: 'tool', content: entry.text_content, tool_call_id: entry.tool_call_id, name: entry.function_name });
            } else {
                if (entry.text_content) messages.push({ role: entry.role, content: entry.text_content });
            }
        }
        const content: any[] = [];
        if (messageText !== '') {
            content.push({
                type: 'text',
                text: messageText
            });
            saveHistory(user, 'user', messageText, '', '');
        }
        if (media && media.mimetype.startsWith('audio/')) {
            let fileName: string = media.filename ?? '';
            if (fileName === '') {
                const extension: string = media.mimetype.split('/')[1]?.split(' ')[0]?.replace(';', '') ?? '';
                if (extension !== '') fileName = 'audio.' + extension;
            }
            let audioResponse: any = await fetch('data:' + media.mimetype + ';base64,' + media.data);
            if (!audioResponse.ok) throw new Error('Failed response when converting audio');
            let audioData: any = await audioResponse.blob();
            const formData: FormData = new FormData();
            if (fileName !== '') {
                formData.append('file', audioData, fileName)
            } else {
                formData.append('file', audioData)
            }
            formData.append('model', modelApiAudioOpenai);
            formData.append('language', audioLanguage);
            formData.append('prompt', 'Transcribe the audio');
            formData.append('response_format', 'json');
            audioResponse = null;
            audioData = null;
            await functionAttempts(async () => {
                audioResponse = await fetch(urlBaseOpenaiAudioApi, {
                    method: 'POST',
                    headers: {
                        'Authorization': 'Bearer ' + tokenOpenaiAudioApi
                    },
                    body: formData
                });
                if (!audioResponse.ok) throw new Error(`Audio API HTTP ${audioResponse.status}`);
                audioData = await audioResponse.json();
                if (!audioData || !audioData.text || (audioData.text === '')) throw new Error();
            });
            if (!audioData || !audioData.text || (audioData.text === '')) throw new Error('Failed response when transcribing audio');
            content.push({
                type: 'text',
                text: audioData.text
            });
            saveHistory(user, 'user', audioData.text, '', '');
        } else if (media && media.mimetype.startsWith('image/') && modelSupportsImage) {
            content.push({
                type: 'image_url',
                image_url: {
                    url: 'data:' + media.mimetype + ';base64,' + media.data
                }
            });
        }
        if (content.length === 0) return;
        messages.push({ role: 'user', content });

        const currentTools: DirectToolDefinition[] = adminUsers.includes(user) ? adminTools : tools;

        // Progressive discovery: evaluate threshold lazily on first message
        // Use a promise to protect against race conditions when multiple messages arrive simultaneously
        if (useDirectLoading === null) {
            if (STABLE_TOOLS_MODE) {
                // Stable tools mode: always use call_tool wrapper for prompt caching optimization
                useDirectLoading = false;
                console.log('Progressive discovery: STABLE MODE (always using call_tool wrapper for prompt caching)');
            } else if (discoveryEvaluationPromise) {
                // Another message is already evaluating, wait for it
                useDirectLoading = await discoveryEvaluationPromise;
            } else {
                // Start evaluation
                discoveryEvaluationPromise = (async () => {
                    try {
                        const toolCount = await mcpClientManager.getToolCount();
                        const directLoading = toolCount <= PROGRESSIVE_DISCOVERY_THRESHOLD;
                        if (directLoading) {
                            console.log(`Progressive discovery: OFF (tool count ${toolCount} <= threshold ${PROGRESSIVE_DISCOVERY_THRESHOLD}, loading directly)`);
                        } else {
                            console.log(`Progressive discovery: ON (tool count ${toolCount} > threshold ${PROGRESSIVE_DISCOVERY_THRESHOLD}, using search meta-tools)`);
                        }
                        return directLoading;
                    } finally {
                        discoveryEvaluationPromise = null;
                    }
                })();
                useDirectLoading = await discoveryEvaluationPromise;
            }
        }

        // Progressive discovery: if threshold not reached, load MCP tools directly
        let finalTools: DirectToolDefinition[] = currentTools;
        if (useDirectLoading === true) {
            try {
                const directMcpTools = await mcpClientManager.getAllToolsForDirectLoading();
                if (directMcpTools.length > 0) {
                    // Sort by tool name for deterministic ordering (prompt caching optimization)
                    // Per MCP best practices: "Append newly discovered definitions after the cache breakpoint"
                    directMcpTools.sort((a, b) => a.function.name.localeCompare(b.function.name));
                    // Merge: built-in tools first, then MCP tools in stable order
                    finalTools = [...currentTools, ...directMcpTools];
                    if (testMode) console.log(`Loaded ${directMcpTools.length} MCP tools directly (below threshold)`);
                }
            } catch (error) {
                console.error('Error loading MCP tools for direct loading, falling back to meta-tools:', error);
                // Keep using meta-tools as fallback
            }
        }

        let currentIteration: number = 0,
            finalResponseContent: string | null = null;

        while (currentIteration < limitTools) {
            currentIteration++;
            let data: any = null;

            // Truncate messages array to fit within token budget before each API call
            const truncated = truncateMessages(messages, maxContextTokens);
            messages.length = 0;
            messages.push(...truncated);

            await functionAttempts(async () => {
                const response: any = await fetch(urlBaseOpenaiApi, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + tokenOpenaiApi
                    },
                    body: JSON.stringify({
                        model: modelApiOpenai,
                        messages,
                        tools: finalTools,
                        tool_choice: 'auto',
                        max_completion_tokens: limitTokensOpenai
                    })
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                data = await response.json();
                if (!data || (data.error && data.error.message && data.error.message.startsWith('Rate limit reached for model'))) {
                    throw new Error(data?.error?.message ?? 'Rate limit reached');
                }
            });

            if (!data || data.error || !data.choices) throw new Error('Failed response. Please try again in a few seconds');
            const aiMessage: any = data.choices[0].message ?? null;
            if (!aiMessage) throw new Error('Failed response. Please try again in a few seconds');
            const toolCalls: any[] = aiMessage.tool_calls ?? [];

            // Only save to history if assistant has content (skip when only tool calls)
            if (aiMessage.content) {
                saveHistory(user, 'assistant', aiMessage.content, '', '');
            }
            messages.push(aiMessage);

            if (toolCalls.length === 0) {
                finalResponseContent = aiMessage.content;
                break;
            }


            for (const toolCall of toolCalls) {
                const functionName: string = toolCall.function.name ?? '';
                let functionResponse: string = 'Failed function response';
                let functionArgs: any = null;
                try {
                    functionArgs = JSON.parse(toolCall.function.arguments);
                } catch {
                    functionResponse = `Error: Invalid JSON in tool arguments for ${functionName}`;
                    messages.push({
                        tool_call_id: toolCall.id,
                        role: 'tool',
                        name: functionName,
                        content: functionResponse
                    });
                    continue;
                }

                // Handle search_tools function
                if (functionName === 'search_tools') {
                    try {
                        const query = functionArgs?.query ?? '';
                        const limit = functionArgs?.limit ?? 10;
                        const detailLevel = functionArgs?.detailLevel ?? 'basic';
                        const searchResults = await mcpClientManager.searchTools(query, limit, detailLevel);

                        // Format results for the LLM using the new delimiter
                        let resultText = 'Search results:\n';
                        if (searchResults.length === 0) {
                            resultText += 'No tools found matching the query.';
                        } else {
                            for (const result of searchResults) {
                                if (detailLevel === 'minimal') {
                                    // Minimal: just the full name
                                    resultText += `- ${MCPClientManager.getFullToolName(result.serverName, result.toolName)}\n`;
                                } else if (detailLevel === 'full') {
                                    // Full: include schemas
                                    resultText += `- ${MCPClientManager.getFullToolName(result.serverName, result.toolName)}: ${result.description}\n`;
                                    if (result.inputSchema) {
                                        resultText += `  Input Schema: ${JSON.stringify(result.inputSchema)}\n`;
                                    }
                                    if (result.outputSchema) {
                                        resultText += `  Output Schema: ${JSON.stringify(result.outputSchema)}\n`;
                                    }
                                } else {
                                    // Basic: name + description
                                    resultText += `- ${MCPClientManager.getFullToolName(result.serverName, result.toolName)}: ${result.description}\n`;
                                }
                            }
                        }
                        functionResponse = resultText;
                    } catch (error) {
                        functionResponse = `Error searching tools: ${error instanceof Error ? error.message : String(error)}`;
                    }
                }
                // Handle search_available_servers function
                else if (functionName === 'search_available_servers') {
                    try {
                        const servers = await mcpClientManager.getAvailableServers();
                        let resultText = 'Available MCP servers:\n';
                        if (servers.length === 0) {
                            resultText += 'No MCP servers configured.';
                        } else {
                            for (const server of servers) {
                                const status = server.connected ? 'connected' : 'disconnected';
                                resultText += `- ${server.name} [${status}]: ${server.description} (${server.toolCount} tools, ${server.type})\n`;
                            }
                        }
                        functionResponse = resultText;
                    } catch (error) {
                        functionResponse = `Error listing servers: ${error instanceof Error ? error.message : String(error)}`;
                    }
                }
                // Handle get_tool_details function
                else if (functionName === 'get_tool_details') {
                    try {
                        const serverName = functionArgs?.serverName;
                        const toolName = functionArgs?.toolName;
                        if (!serverName || !toolName) {
                            functionResponse = 'Error: serverName and toolName are required';
                        } else {
                            const toolDetails = await mcpClientManager.getToolDetails(serverName, toolName);
                            // Format the tool details for the LLM
                            let resultText = `Tool Details:\n`;
                            resultText += `Server: ${serverName}\n`;
                            resultText += `Name: ${toolDetails.name}\n`;
                            resultText += `Full Name: ${MCPClientManager.getFullToolName(serverName, toolDetails.name)}\n`;
                            resultText += `Description: ${toolDetails.description || 'No description available'}\n`;
                            if (toolDetails.inputSchema) {
                                resultText += `Input Schema: ${JSON.stringify(toolDetails.inputSchema, null, 2)}\n`;
                            } else {
                                resultText += `Input Schema: Not available\n`;
                            }
                            if (toolDetails.outputSchema) {
                                resultText += `Output Schema: ${JSON.stringify(toolDetails.outputSchema, null, 2)}\n`;
                            } else {
                                resultText += `Output Schema: Not available\n`;
                            }
                            functionResponse = resultText;
                        }
                    } catch (error) {
                        functionResponse = `Error getting tool details: ${error instanceof Error ? error.message : String(error)}`;
                    }
                }
                // Handle call_tool function (single tool call via stable wrapper)
                // This keeps the LLM tools array stable for prompt caching optimization
                else if (functionName === 'call_tool') {
                    try {
                        const serverName = functionArgs?.serverName;
                        const toolName = functionArgs?.toolName;
                        const args = functionArgs?.args ?? {};
                        if (!serverName || !toolName) {
                            functionResponse = 'Error: serverName and toolName are required';
                        } else {
                            const result = await mcpClientManager.callTool(serverName, toolName, args);
                            functionResponse = truncateToolResult(extractMcpResultText(result));
                        }
                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        functionResponse = `Error calling tool: ${errorMessage}`;
                    }
                }
                // Handle execute_tool_sequence (sandboxed programmatic tool calling per MCP best practices)
                // Runs steps in an isolated Bun subprocess with tool stubs.
                // Only the final summary returns to the model, keeping intermediate results out of context.
                else if (functionName === 'execute_tool_sequence') {
                    try {
                        const steps = functionArgs?.steps ?? [];
                        const summaryPrompt = functionArgs?.summary ?? 'Summarize the results';

                        // Validate max steps to prevent runaway execution
                        const MAX_STEPS = 20;
                        if (!Array.isArray(steps) || steps.length === 0) {
                            functionResponse = 'Error: steps must be a non-empty array';
                        } else if (steps.length > MAX_STEPS) {
                            functionResponse = `Error: too many steps (${steps.length}). Maximum allowed is ${MAX_STEPS}`;
                        } else {
                            // Validate all steps upfront
                            const validatedSteps: SandboxStep[] = [];
                            for (let i = 0; i < steps.length; i++) {
                                const step = steps[i];
                                if (!step || typeof step !== 'object') {
                                    validatedSteps.push({ index: i, serverName: '', toolName: '', args: {}, valid: false, error: 'step must be an object' });
                                    continue;
                                }
                                const { serverName, toolName, args, saveAs, useResultFrom } = step;
                                if (!serverName || !toolName) {
                                    validatedSteps.push({ index: i, serverName: '', toolName: '', args: {}, valid: false, error: 'serverName and toolName are required' });
                                    continue;
                                }
                                if (typeof serverName !== 'string' || typeof toolName !== 'string') {
                                    validatedSteps.push({ index: i, serverName: '', toolName: '', args: {}, valid: false, error: 'serverName and toolName must be strings' });
                                    continue;
                                }
                                if (saveAs && (typeof saveAs !== 'string' || saveAs === '__proto__' || saveAs === 'constructor' || saveAs === 'prototype')) {
                                    validatedSteps.push({ index: i, serverName: '', toolName: '', args: {}, valid: false, error: 'invalid saveAs key' });
                                    continue;
                                }
                                validatedSteps.push({ index: i, serverName, toolName, args: args ?? {}, saveAs, useResultFrom, valid: true });
                            }

                            // Get available tool stubs for the sandbox
                            const toolStubs = await mcpClientManager.getToolsForSandbox();
                            if (toolStubs.length === 0) {
                                functionResponse = 'No MCP tools available. Connect to an MCP server first.';
                            } else {
                                // Execute in sandboxed subprocess — intermediate results stay isolated
                                const result = await sandboxRunner.executeToolSequence(validatedSteps, toolStubs, sandboxTimeoutMs, summaryPrompt);

                                let responseText = '';
                                if (result.error) {
                                    responseText = `Sandbox error: ${result.error}`;
                                    if (result.output) responseText += `\nOutput before error:\n${result.output}`;
                                } else {
                                    responseText = result.output || '(no output)';
                                }
                                if (result.toolCalls > 0) {
                                    responseText += `\n(${result.toolCalls} tool call(s) executed)`;
                                }
                                functionResponse = responseText;
                            }
                        }
                    } catch (error) {
                        functionResponse = `Error executing tool sequence: ${error instanceof Error ? error.message : String(error)}`;
                    }
                }
                // Handle execute_code (sandboxed programmatic tool calling per MCP best practices)
                // Runs model-generated code in an isolated Bun subprocess with tool stubs.
                // Only console output returns to the model, keeping intermediate results out of context.
                else if (functionName === 'execute_code') {
                    try {
                        const code = functionArgs?.code;
                        if (!code || typeof code !== 'string') {
                            functionResponse = 'Error: code must be a non-empty string';
                        } else {
                            // Get available tool stubs for the sandbox
                            const toolStubs = await mcpClientManager.getToolsForSandbox();
                            if (toolStubs.length === 0) {
                                functionResponse = 'No MCP tools available for sandbox execution. Connect to an MCP server first.';
                            } else {
                                const result = await sandboxRunner.execute(code, toolStubs, sandboxTimeoutMs);

                                let responseText = '';
                                if (result.error) {
                                    responseText = `Sandbox error: ${result.error}`;
                                    if (result.output) responseText += `\nOutput before error:\n${result.output}`;
                                } else {
                                    responseText = result.output || '(no output)';
                                }
                                if (result.toolCalls > 0) {
                                    responseText += `\n(${result.toolCalls} tool call(s) executed)`;
                                }
                                functionResponse = responseText;
                            }
                        }
                    } catch (error) {
                        functionResponse = `Error in sandbox execution: ${error instanceof Error ? error.message : String(error)}`;
                    }
                }
                // Check if this is an MCP tool (using the __ delimiter)
                else {
                    const parsedTool = MCPClientManager.parseToolName(functionName);
                    if (parsedTool) {
                        const { serverName, toolName } = parsedTool;
                        try {
                            // callTool handles ensureServerConnected and isError->throw internally
                            const result = await mcpClientManager.callTool(serverName, toolName, functionArgs);
                            functionResponse = truncateToolResult(extractMcpResultText(result));
                        } catch (error) {
                            // Transport errors AND MCP tool errors (isError: true) both end up here
                            const errorMessage = error instanceof Error ? error.message : String(error);
                            functionResponse = `Error calling MCP tool ${toolName}: ${errorMessage}`;
                        }
                    } else {
                        // Handle regular (non-MCP) functions
                        if (functionName === 'clean_current_chat') {
                            functionResponse = await cleanCurrentChat(user);
                        } else if (adminUsers.includes(user)) {
                            if (functionName === 'clean_chat') {
                                const targetUser = functionArgs?.user;
                                if (!targetUser) {
                                    functionResponse = 'Error: user parameter is required for clean_chat';
                                } else {
                                    functionResponse = await cleanChat(targetUser);
                                }
                            } else if (functionName === 'clean_all_chats') {
                                functionResponse = await cleanAllChats();
                            }
                        }
                    }
                }

                messages.push({
                    tool_call_id: toolCall.id,
                    role: 'tool',
                    name: functionName,
                    content: functionResponse
                });
            }
        }
        if (!finalResponseContent) finalResponseContent = 'Sorry, I could not complete your request after several attempts.';
        const mediaUrls: any = finalResponseContent.match(/(https?:\/\/[^\s]+)/g);
        if (mediaUrls && mediaUrls.length !== 0) {
            finalResponseContent = finalResponseContent.replaceAll(/(https?:\/\/[^\s]+)/g, '').trim();
            if (finalResponseContent !== '') {
                await client.sendMessage(message.from, finalResponseContent);
            }
            for (const mediaUrl of mediaUrls) {
                await client.sendMessage(message.from, (await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true })));
            }
        } else {
            await client.sendMessage(message.from, finalResponseContent);
        }
    } catch (error: any) {
        console.error(`Error for user ${user}:`, error);
        saveHistory(user, 'assistant', 'An error occurred processing your request. Please try again.', '', '');
        await client.sendMessage(message.from, 'An error occurred processing your request. Please try again.');
    } finally {
        // Always release the session lock, even if the catch block throws
        if (!currentSession) sessions.delete(user);
    }
});

client.initialize();

// Graceful shutdown: disconnect MCP servers and close database on process exit
let isShuttingDown = false;
const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('\nShutting down, disconnecting MCP servers and closing database...');
    await mcpClientManager.disconnectAll();
    closeDatabase();
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('beforeExit', () => {
    if (!isShuttingDown) {
        mcpClientManager.disconnectAll().catch(() => { });
        closeDatabase();
    }
});

// Handle unhandled errors: ensure MCP servers are disconnected and DB is closed
// Per MCP best practices: "Handle server disconnections" and proper resource cleanup
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    if (!isShuttingDown) {
        mcpClientManager.disconnectAll().catch(() => { });
        closeDatabase();
    }
});
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    if (!isShuttingDown) {
        mcpClientManager.disconnectAll().catch(() => { });
        closeDatabase();
    }
    process.exit(1);
});