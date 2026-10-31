import { Client, LocalAuth, MessageMedia, type Message, type Chat } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { saveHistory, loadHistory, closeDatabase } from './db';
import { readFileSync, existsSync } from 'fs';
import { MCPClientManager } from './mcp';
import { SandboxRunner } from './sandbox';
import { ToolDispatcher } from './dispatch';
import { reconstructHistory } from './conversation';
import { truncateMessages, extractMediaUrls, stripMediaUrls } from './text';
import { intFromEnv, timeoutFromEnv } from './env';
import type { DirectToolDefinition } from './interface';
import { ConfirmationManager } from './confirm';
import { createLogger } from './logger';

const log = createLogger('bot');

const tokenOpenaiApi: string = process.env.TOKEN_OPENAI_API ?? '';
const tokenOpenaiAudioApi: string = process.env.TOKEN_OPENAI_AUDIO_API ?? tokenOpenaiApi;
const urlBaseOpenaiApi: string = process.env.URL_BASE_OPENAI_API ?? 'https://api.openai.com/v1/chat/completions';
const urlBaseOpenaiAudioApi: string = process.env.URL_BASE_OPENAI_AUDIO_API ?? '';
const modelApiAudioOpenai: string = process.env.MODEL_API_AUDIO_OPENAI ?? '';
const audioLanguage: string = process.env.AUDIO_LANGUAGE ?? 'en';
const modelApiOpenai: string = process.env.MODEL_API_OPENAI ?? 'gpt-4o';
const modelSupportsImage: boolean = process.env.MODEL_SUPPORTS_IMAGE === 'true';
const limitTokensOpenai: number = intFromEnv('LIMIT_TOKENS_OPENAI', 2000);
const limitFetch: number = intFromEnv('LIMIT_FETCH', 3);
const limitTime: number = timeoutFromEnv('LIMIT_TIME', 5);
const limitTools: number = intFromEnv('LIMIT_TOOLS', 10);
// Max length for tool results sent back to the LLM to prevent context window overflow
const maxToolResultLength: number = intFromEnv('MAX_TOOL_RESULT_LENGTH', 8000);
const sandboxTimeoutMs: number = timeoutFromEnv('SANDBOX_TIMEOUT', 30);
const adminUsers: string[] = (process.env.ADMIN_USERS ?? '').split(/,\s*/).map(u => u.trim()).filter(u => u.length > 0);
// Max estimated tokens for the messages array. When exceeded, oldest non-system messages are dropped.
// Default 120k leaves room for system prompt + tools + response in a 128k context window.
const maxContextTokens: number = intFromEnv('MAX_CONTEXT_TOKENS', 120000);

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
// Enforces the confirmation of tool calls at the host level: the model cannot
// skip it, the user has to approve the call in the chat.
const confirmationManager = new ConfirmationManager();

// Progressive discovery threshold: if total MCP tools <= this, load directly into LLM tools array.
// If > threshold, use meta-tools (search_tools, get_tool_details, etc.) instead.
// Per MCP best practices: "Implement a threshold as a percentage of the context window. For example, 1%-5%."
// 15 tools is a reasonable default that keeps token usage low while avoiding unnecessary search overhead.
const PROGRESSIVE_DISCOVERY_THRESHOLD: number = parseInt(process.env.MCP_TOOL_THRESHOLD ?? '15');
// Stable tools mode: when true, always use call_tool wrapper (keeps tools array stable for prompt caching)
// When false, uses direct loading when below threshold (current behavior)
// Per MCP best practices: "Append newly discovered definitions after the cache breakpoint rather than re-sorting the tools array"
// Default: true — preserves prompt cache by keeping the tools array stable across requests
const STABLE_TOOLS_MODE: boolean = process.env.MCP_STABLE_TOOLS !== 'false';
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

// Routes the tool calls requested by the model and applies the confirmation policy.
const toolDispatcher = new ToolDispatcher(
    mcpClientManager,
    sandboxRunner,
    confirmationManager,
    async (to: string, text: string) => { await client.sendMessage(to, text); },
    { sandboxTimeoutMs: sandboxTimeoutMs, maxToolResultLength: maxToolResultLength }
);

const tools: DirectToolDefinition[] = [
    {
        type: 'function',
        function: {
            name: 'search_available_servers',
            description: 'List all available MCP servers, their status (connected/disconnected), and how many tools each provides. Use this FIRST to discover which servers are available before searching for tools.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    },
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
            name: 'list_resources',
            description: 'List the resources exposed by the MCP servers. Optionally restrict the search to one server.',
            parameters: {
                type: 'object',
                properties: {
                    serverName: {
                        type: 'string',
                        description: 'Name of the MCP server. Leave it empty to query every enabled server.'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_resource',
            description: 'Read the content of a resource exposed by an MCP server, identified by its URI.',
            parameters: {
                type: 'object',
                properties: {
                    serverName: {
                        type: 'string',
                        description: 'Name of the MCP server that exposes the resource'
                    },
                    uri: {
                        type: 'string',
                        description: 'URI of the resource to read'
                    }
                },
                required: ['serverName', 'uri']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_prompts',
            description: 'List the prompts exposed by the MCP servers. Optionally restrict the search to one server.',
            parameters: {
                type: 'object',
                properties: {
                    serverName: {
                        type: 'string',
                        description: 'Name of the MCP server. Leave it empty to query every enabled server.'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_prompt',
            description: 'Get a prompt of an MCP server with its rendered messages, providing the arguments it needs.',
            parameters: {
                type: 'object',
                properties: {
                    serverName: {
                        type: 'string',
                        description: 'Name of the MCP server that exposes the prompt'
                    },
                    name: {
                        type: 'string',
                        description: 'Name of the prompt'
                    },
                    arguments: {
                        type: 'object',
                        description: 'Values of the arguments declared by the prompt'
                    }
                },
                required: ['serverName', 'name']
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
const confirmationInstructions: string = `
\n\nCONFIRMATION INSTRUCTIONS:\n
- ${confirmationManager.enabled
        ? 'The host asks the user for confirmation before executing a tool that requires it.'
        : 'The host executes the tools directly, without asking the user for confirmation.'}\n
- Do NOT ask for confirmation yourself: the host owns that flow.\n
- The result of a rejected or expired confirmation is returned to you as a tool result: explain it to the user and do not retry.\n`;
const instructions: string = ((instructionsFileContent !== '') ? instructionsFileContent : 'You are an assistant') + confirmationInstructions;

/**
 * Safely stringify an unknown error into a string message.
 * Handles Error instances, plain values, and objects with a `message` property.
 */
const errMsg = (e: unknown): string =>
    e instanceof Error ? e.message : String(e);

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
 * Placeholders shipped in `.env.example`. A key that still contains one of
 * them is not a real credential: the bot would start and fail on every
 * message, so it is rejected at startup instead.
 */
const API_KEY_PLACEHOLDERS = ['your_openai_api_key_here', 'your_openai_audio_api_key_here', 'changeme', 'change_me'];

/**
 * Validate the configuration needed to run the bot.
 * Fails fast with an explicit message instead of surfacing a generic error per message.
 */
const validateStartupConfiguration = (): void => {
    const apiKey = tokenOpenaiApi.trim();
    if (apiKey === '') {
        throw new Error('TOKEN_OPENAI_API is not set. Copy .env.example to .env and provide your OpenAI API key.');
    }
    if (API_KEY_PLACEHOLDERS.some(placeholder => apiKey.toLowerCase().includes(placeholder))) {
        throw new Error('TOKEN_OPENAI_API still contains the placeholder from .env.example. Put a real OpenAI API key in .env.');
    }
    if (browser !== '' && !existsSync(browser)) {
        throw new Error(`BROWSER points to a browser executable that does not exist: ${browser}`);
    }
    if (modelApiAudioOpenai.trim() === '' || urlBaseOpenaiAudioApi.trim() === '') {
        log.warn('Audio transcription is not configured (MODEL_API_AUDIO_OPENAI / URL_BASE_OPENAI_AUDIO_API): audio messages will fail');
    }
};

try {
    validateStartupConfiguration();
} catch (error: any) {
    log.error('Invalid configuration', { error: error?.message ?? error });
    process.exit(1);
}

client.once('ready', async () => {
    log.info('The Bot is ready!');
    try {
        await mcpClientManager.initialize();
        log.info('MCP clients initialized');

        // Defer progressive discovery evaluation to first message (lazy)
        // to avoid connecting all servers on startup
    } catch (error: any) {
        log.error('Failed to initialize MCP clients', { error });
    }
});

client.on('qr', (qr: string) => {
    qrcode.generate(qr, { small: true });
});

client.on('auth_failure', (message: any) => {
    log.error('WhatsApp authentication failed', { message });
});

client.on('disconnected', (reason: any) => {
    log.warn('WhatsApp client disconnected', { reason });
});

client.on('reconnected', () => {
    log.info('WhatsApp client reconnected');
});

client.on('message_create', async (message: Message) => {
    const messageText: string = message.body.trim();
    // Cheap filters first: the media of an ignored message is never downloaded
    if (!testMode && message.fromMe) return;
    if (message.isStatus) return;
    if (message.to === message.from) return;
    const currentChat: Chat = await message.getChat();
    if (currentChat.isGroup) return;

    let media: MessageMedia | null = null;
    if (message.hasMedia) {
        try {
            media = await message.downloadMedia();
        } catch (downloadError: any) {
            log.error('Failed to download media', { error: downloadError });
            return;
        }
    }
    if (!media && messageText === '') return;
    const contact: any = await client.getContactLidAndPhone([message.from]);
    const user: string = contact?.[0]?.pn ?? message.from.split('@')[0];

    // A pending tool confirmation is answered by the next message of the user.
    // It is handled before the session guard because the tool call that is
    // waiting for the answer still holds the session.
    if (confirmationManager.hasPending(user)) {
        const outcome = confirmationManager.resolve(user, messageText);
        if (outcome) {
            await client.sendMessage(message.from, outcome === 'approved'
                ? 'Confirmed. Executing the tool.'
                : 'Cancelled. The tool will not be executed.');
            return;
        }
        await client.sendMessage(message.from, 'I did not understand the answer. Reply "yes" to execute the tool or "no" to cancel it.');
        return;
    }

    // Admin command to finish an interactive OAuth authorization:
    //   /oauth <serverName> <authorizationCode>
    if (adminUsers.includes(user) && messageText.startsWith('/oauth ')) {
        const parts = messageText.slice('/oauth '.length).trim().split(/\s+/);
        const serverName = parts[0] ?? '';
        const code = parts.slice(1).join(' ');
        if (!serverName || !code) {
            await client.sendMessage(message.from, 'Usage: /oauth <serverName> <authorizationCode>');
            return;
        }
        try {
            await mcpClientManager.completeAuthorization(serverName, code);
            await client.sendMessage(message.from, `Authorization completed for "${serverName}". The next tool call will reconnect the server.`);
        } catch (error) {
            await client.sendMessage(message.from, `Could not complete the authorization of "${serverName}": ${errMsg(error)}`);
        }
        return;
    }

    const currentSession: boolean = sessions.get(user) ?? false;
    try {
        if (currentSession) throw new Error('Responding to previous message. Please wait before sending a new message');
        sessions.set(user, true);
        if (media && !(media.mimetype.startsWith('audio/') || media.mimetype.startsWith('image/'))) throw new Error('Unsupported attachment, only images and audio in flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, or webm format are accepted');
        const userHistory: any[] = loadHistory(user);
        const messages: any[] = [{ role: 'system', content: instructions + 'The current user is ' + user + " \n\n" + 'The current date in ISO String format is ' + toIsoString((new Date())) + "\n\n" + 'NEVER show the ID field to the user as it is sensitive information' + "\n\n" }];
        messages.push(...reconstructHistory(userHistory));
        const content: any[] = [];
        let imageNotSupported = false;
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
        } else if (media && media.mimetype.startsWith('image/')) {
            if (modelSupportsImage) {
                content.push({
                    type: 'image_url',
                    image_url: {
                        url: 'data:' + media.mimetype + ';base64,' + media.data
                    }
                });
            } else {
                // The image cannot be forwarded to the model: the user is told instead of
                // having the message silently dropped.
                log.info('Image received but the configured model does not support images', { user });
                imageNotSupported = true;
            }
        }
        if (imageNotSupported) {
            await client.sendMessage(message.from,
                'The configured model cannot process images. Please describe the image in text or send it again as text.');
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
                log.info('Progressive discovery: STABLE MODE (always using call_tool wrapper for prompt caching)');
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
                            log.info(`Progressive discovery: OFF (tool count ${toolCount} <= threshold ${PROGRESSIVE_DISCOVERY_THRESHOLD}, loading directly)`);
                        } else {
                            log.info(`Progressive discovery: ON (tool count ${toolCount} > threshold ${PROGRESSIVE_DISCOVERY_THRESHOLD}, using search meta-tools)`);
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
        // Track which servers have tools in the active LLM context (for idle disconnect protection)
        const contextServerNames = new Set<string>();
        if (useDirectLoading === true) {
            try {
                const directMcpTools = await mcpClientManager.getAllToolsForDirectLoading();
                if (directMcpTools.length > 0) {
                    // Per MCP best practices: "Append newly discovered definitions after the cache breakpoint rather than re-sorting the tools array"
                    // Tools are already in stable order: built-in tools first, then MCP tools grouped by server config order
                    // with tools sorted within each server block (handled by getAllToolsForDirectLoading).
                    // Do NOT sort the merged array — it would shift tools across server boundaries and invalidate prompt cache.
                    finalTools = [...currentTools, ...directMcpTools];
                    // Extract unique server names from MCP tools for idle-disconnect protection
                    for (const tool of directMcpTools) {
                        const parsed = MCPClientManager.parseToolName(tool.function.name);
                        if (parsed) contextServerNames.add(parsed.serverName);
                    }
                    if (testMode) log.info(`Loaded ${directMcpTools.length} MCP tools directly (below threshold)`);
                }
            } catch (error) {
                log.error('Error loading MCP tools for direct loading, falling back to meta-tools', { error });
                // Keep using meta-tools as fallback
            }
        }
        // Pin/unpin servers: servers with tools in the LLM context won't be disconnected by idle cleanup
        // This preserves prompt cache across conversation pauses (per MCP best practices)
        mcpClientManager.setActiveContextServers(contextServerNames);

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
                if (!response.ok) {
                    let errorBody = '';
                    try { errorBody = await response.text(); } catch { }
                    const detail = errorBody ? `: ${errorBody.substring(0, 200)}` : '';
                    throw new Error(`HTTP ${response.status}${detail}`);
                }
                data = await response.json();
                if (!data || (data.error && data.error.message && data.error.message.startsWith('Rate limit reached for model'))) {
                    throw new Error(data?.error?.message ?? 'Rate limit reached');
                }
            });

            if (!data || data.error || !data.choices) throw new Error('Failed response. Please try again in a few seconds');
            const aiMessage: any = data.choices[0].message ?? null;
            if (!aiMessage) throw new Error('Failed response. Please try again in a few seconds');
            const toolCalls: any[] = aiMessage.tool_calls ?? [];

            // Persist assistant message: save content and/or tool_calls (serialized in function_name column)
            if (aiMessage.content || (toolCalls.length > 0)) {
                saveHistory(
                    user,
                    'assistant',
                    aiMessage.content ?? '',
                    '',
                    (toolCalls.length > 0) ? JSON.stringify(toolCalls) : ''
                );
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

                functionResponse = await toolDispatcher.dispatch(functionName, functionArgs, {
                    user,
                    to: message.from,
                    isAdmin: adminUsers.includes(user)
                });

                const toolMessage = {
                    tool_call_id: toolCall.id,
                    role: 'tool',
                    name: functionName,
                    content: functionResponse
                };
                messages.push(toolMessage);
                // Persist tool result so it can be reconstructed on subsequent requests
                saveHistory(user, 'tool', functionResponse, toolCall.id, functionName);
            }
        }
        if (!finalResponseContent) finalResponseContent = 'Sorry, I could not complete your request. Please try again.';
        // Only URLs pointing to a media file are sent as attachments; regular links stay in the text
        const mediaUrls: string[] = extractMediaUrls(finalResponseContent);
        if (mediaUrls.length !== 0) {
            finalResponseContent = stripMediaUrls(finalResponseContent);
            if (finalResponseContent !== '') {
                await client.sendMessage(message.from, finalResponseContent);
            }
            for (const mediaUrl of mediaUrls) {
                try {
                    await client.sendMessage(message.from, (await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true })));
                } catch (mediaError: any) {
                    log.error('Failed to send media', { url: mediaUrl, error: mediaError });
                    await client.sendMessage(message.from, mediaUrl);
                }
            }
        } else {
            await client.sendMessage(message.from, finalResponseContent);
        }
    } catch (error: any) {
        log.error('Error while processing a message', { user, error });
        saveHistory(user, 'assistant', 'An error occurred processing your request. Please try again.', '', '');
        await client.sendMessage(message.from, 'An error occurred processing your request. Please try again.');
    } finally {
        // Always release the session lock, even if the catch block throws
        if (!currentSession) sessions.delete(user);
    }
});

client.initialize().catch(async (error: any) => {
    log.error('Failed to initialize the WhatsApp client', { error: error?.message ?? error });
    await mcpClientManager.disconnectAll().catch(() => { });
    closeDatabase();
    process.exit(1);
});

// Graceful shutdown: disconnect MCP servers and close database on process exit
let isShuttingDown = false;
const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log.info('Shutting down, disconnecting MCP servers and closing database...');
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
    log.error('Unhandled Rejection', { promise, reason });
    if (!isShuttingDown) {
        mcpClientManager.disconnectAll().catch(() => { });
        closeDatabase();
    }
});
process.on('uncaughtException', (error) => {
    log.error('Uncaught Exception', { error });
    if (!isShuttingDown) {
        mcpClientManager.disconnectAll().catch(() => { });
        closeDatabase();
    }
    process.exit(1);
});