import { Client, LocalAuth, MessageMedia, type Message, type Chat } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { saveHistory, loadHistory, resetHistory, resetAllHistory } from './db';
import { readFileSync, existsSync } from 'fs';
import { MCPClientManager } from './mcp';

const tokenOpenaiApi: string = process.env.TOKEN_OPENAI_API ?? '';
const tokenOpenaiAudioApi: string = process.env.TOKEN_OPENAI_AUDIO_API ?? tokenOpenaiApi;
const urlBaseOpenaiApi: string = process.env.URL_BASE_OPENAI_API ?? 'https://api.openai.com/v1/chat/completions';
const urlBaseOpenaiAudioApi: string = process.env.URL_BASE_OPENAI_AUDIO_API ?? '';
const modelApiAudioOpenai: string = process.env.MODEL_API_AUDIO_OPENAI ?? '';
const modelApiOpenai: string = process.env.MODEL_API_OPENAI ?? 'gpt-4o';
const modelSupportsImage: boolean = ((process.env.MODEL_SUPPORTS_IMAGE !== undefined) && (process.env.MODEL_SUPPORTS_IMAGE == 'true')) ? true : false;
const limitTokensOpenai: number = parseInt(process.env.LIMIT_TOKENS_OPENAI ?? '2000');
const limitFetch: number = parseInt(process.env.LIMIT_FETCH ?? '3');
const limitTime: number = parseInt(process.env.LIMIT_TIME ?? '5') * 1000;
const limitTools: number = parseInt(process.env.LIMIT_TOOLS ?? '10');
const adminUsers: string[] = ((process.env.ADMIN_USERS !== undefined) && (process.env.ADMIN_USERS.includes(', '))) ? process.env.ADMIN_USERS.trim().split(', ') : ((process.env.ADMIN_USERS !== undefined) ? [process.env.ADMIN_USERS.trim()] : []);

interface PuppeterConfig {
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

const puppeteer: PuppeterConfig = {
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
const testMode: boolean = ((process.env.TEST_MODE !== undefined) && (process.env.TEST_MODE == 'true')) ? true : false;
const mcpClientManager = new MCPClientManager();

const client = new Client({
    puppeteer,
    authStrategy: new LocalAuth({
        dataPath: 'auth'
    })
});

const tools: any[] = [
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
            description: 'Search for available tools across all connected MCP servers',
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
    }
];
const adminTools: any[] = [
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

const functionAttempts = async (functionAttempt: any) => {
    let attempts: number = 0;
    while (attempts < limitFetch) {
        try {
            return await functionAttempt();
        } catch (error: any) {
            attempts++;
            if (attempts < limitFetch) await new Promise(resolve => setTimeout(resolve, limitTime));
        }
    }
    return false;
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

client.once('ready', async () => {
    console.error('The Bot is ready!');
    try {
        await mcpClientManager.initialize();
        console.log('MCP clients initialized');
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
    if (message.hasMedia) media = await message.downloadMedia();
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
            if (entry.role == 'tool') {
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
            formData.append('language', 'en');
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
                if (!audioResponse.ok) throw new Error();
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

        const currentTools: any[] = adminUsers.includes(user) ? adminTools : tools;
        let currentIteration: number = 0,
            finalResponseContent: string | null = null;

        while (currentIteration < limitTools) {
            currentIteration++;
            let data: any = null;

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
                        tools: currentTools,
                        tool_choice: 'auto',
                        max_completion_tokens: limitTokensOpenai
                    })
                });
                if (!response.ok) throw new Error();
                data = await response.json();
                if (!data || (data.error && data.error.message && data.error.message.startsWith('Rate limit reached for model'))) throw new Error();
            });

            if (!data || data.error || !data.choices) throw new Error('Failed response. Please try again in a few seconds');
            const aiMessage: any = data.choices[0].message ?? null;
            if (!aiMessage) throw new Error('Failed response. Please try again in a few seconds');
            const toolCalls: any[] = aiMessage.tool_calls ?? [];

            saveHistory(user, 'assistant', aiMessage.content, '', '');
            messages.push(aiMessage);

            if (toolCalls.length === 0) {
                finalResponseContent = aiMessage.content;
                break;
            }


            for (const toolCall of toolCalls) {
                const functionName: string = toolCall.function.name ?? '';
                const functionArgs: any = JSON.parse(toolCall.function.arguments) ?? null;
                let functionResponse: string = 'Failed function response';

                // Handle search_tools function
                if (functionName === 'search_tools') {
                    try {
                        const query = functionArgs?.query ?? '';
                        const limit = functionArgs?.limit ?? 10;
                        const searchResults = await mcpClientManager.searchTools(query, limit);

                        // Format results for the LLM
                        let resultText = 'Search results:\n';
                        if (searchResults.length === 0) {
                            resultText += 'No tools found matching the query.';
                        } else {
                            for (const result of searchResults) {
                                resultText += `- ${result.serverName}_${result.toolName}: ${result.description}\n`;
                            }
                        }
                        functionResponse = resultText;
                    } catch (error) {
                        functionResponse = `Error searching tools: ${error instanceof Error ? error.message : String(error)}`;
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
                            resultText += `Server: ${toolDetails.serverName || serverName}\n`;
                            resultText += `Name: ${toolDetails.name}\n`;
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
                // Check if this is an MCP tool (prefixed with server name)
                else {
                    const mcpToolMatch = functionName.match(/^(.+?)_(.+)$/);
                    if (mcpToolMatch) {
                        const [, serverNameMatch, toolNameMatch] = mcpToolMatch;
                        if (serverNameMatch && toolNameMatch) {
                            const serverName = serverNameMatch;
                            const toolName = toolNameMatch;
                            const client = mcpClientManager.getClient(serverName);
                            if (client) {
                                let result;
                                try {
                                    result = await mcpClientManager.callTool(serverName, toolName, functionArgs);
                                } catch (error) {
                                    // Transport or connection error
                                    const errorMessage = error instanceof Error ? error.message : String(error);
                                    functionResponse = `Error calling MCP tool ${toolName}: ${errorMessage}`;
                                }

                                // Check if tool execution resulted in an error (per MCP spec)
                                if (result && typeof result === 'object' && 'isError' in result && result.isError) {
                                    // Extract error information from result
                                    let errorMessage = 'Tool execution failed';
                                    if (result.content && Array.isArray(result.content)) {
                                        // Try to get text content from error result
                                        for (const content of result.content) {
                                            if (content.type === 'text') {
                                                errorMessage = content.text;
                                                break;
                                            }
                                        }
                                    }
                                    // If we couldn't get text content, fall back to stringifying
                                    if (errorMessage === 'Tool execution failed') {
                                        errorMessage = JSON.stringify(result);
                                    }
                                    functionResponse = `Error from tool ${toolName}: ${errorMessage}`;
                                } else {
                                    // Successful tool execution - extract text content
                                    let textContent = '';
                                    if (result && result.content && Array.isArray(result.content)) {
                                        for (const content of result.content) {
                                            if (content.type === 'text') {
                                                textContent += content.text + '\n';
                                            }
                                            // For other content types, we could handle them differently
                                            // For now, we'll just note their presence
                                            else if (content.type === 'image' || content.type === 'audio') {
                                                textContent += `[${content.type} content not displayed in text chat]\n`;
                                            }
                                            else if (content.type === 'resource') {
                                                const res = content.resource as any;
                                                textContent += `[Resource: ${res.uri || 'unknown'}]\n`;
                                            }
                                        }
                                    }

                                    // Remove trailing newline
                                    textContent = textContent.trimEnd();

                                    // If no text content found, fall back to stringifying
                                    if (textContent === '') {
                                        textContent = JSON.stringify(result);
                                    }

                                    functionResponse = textContent;
                                }
                            } else {
                                functionResponse = `MCP client for server ${serverName} not found`;
                            }
                        } else {
                            functionResponse = 'Invalid MCP tool format';
                        }
                    } else {
                        // Handle regular (non-MCP) functions
                        if (functionName == 'clean_current_chat') {
                            functionResponse = await cleanCurrentChat(user);
                        } else if (adminUsers.includes(user)) {
                            if (functionName == 'clean_chat') {
                                functionResponse = await cleanChat(functionArgs.user);
                            } else if (functionName == 'clean_all_chats') {
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
            finalResponseContent = finalResponseContent.replaceAll(/(https?:\/\/[^\s]+)/g, '');
            await client.sendMessage(message.from, finalResponseContent);
            for (const mediaUrl of mediaUrls) {
                await client.sendMessage(message.from, (await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true })));
            }
        } else {
            await client.sendMessage(message.from, finalResponseContent);
        }
    } catch (error: any) {
        if (testMode) console.error(error);
        saveHistory(user, 'assistant', error.message, '', '');
        await client.sendMessage(message.from, error.message);
    }
    if (!currentSession) sessions.delete(user);
});

client.initialize();