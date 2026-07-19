import { Client, LocalAuth, MessageMedia, type Message, type Chat } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { saveHistory, loadHistory, resetHistory, resetAllHistory } from './db';
import { readFileSync, existsSync } from 'fs';

const tokenOpenaiApi: string = process.env.TOKEN_OPENAI_API ?? '';
const tokenOpenaiAudioApi: string = process.env.TOKEN_OPENAI_AUDIO_API ?? tokenOpenaiApi;
const urlBaseOpenaiApi: string = process.env.URL_BASE_OPENAI_API ?? 'https://api.openai.com/v1/chat/completions';
const urlBaseOpenaiAudioApi: string = process.env.URL_BASE_OPENAI_AUDIO_API ?? '';
const modeloApiAudioOpenai: string = process.env.MODEL_API_AUDIO_OPENAI ?? '';
const modeloApiOpenai: string = process.env.MODEL_API_OPENAI ?? 'gpt-4o';
const modeloSoportaImagen: boolean = ((process.env.MODEL_SUPPORTS_IMAGE !== undefined) && (process.env.MODEL_SUPPORTS_IMAGE == 'true')) ? true : false;
const limiteTokensOpenai: number = parseInt(process.env.LIMIT_TOKENS_OPENAI ?? '2000');
const limiteFetch: number = parseInt(process.env.LIMIT_FETCH ?? '3');
const limiteTiempo: number = parseInt(process.env.LIMIT_TIME ?? '5') * 1000;
const limiteHerramientas: number = parseInt(process.env.LIMIT_TOOLS ?? '10');
const usuariosAdministradores: string[] = ((process.env.ADMIN_USERS !== undefined) && (process.env.ADMIN_USERS.includes(', '))) ? process.env.ADMIN_USERS.trim().split(', ') : ((process.env.ADMIN_USERS !== undefined) ? [process.env.ADMIN_USERS.trim()] : []);

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
const navegador: string = process.env.BROWSER ?? '';

if (navegador !== '') {
    puppeteer.chrome = {
        skipDownload: true
    };
    puppeteer.firefox = {
        skipDownload: true
    };
    puppeteer.executablePath = navegador;
}

const sesiones: Map<string, boolean> = new Map<string, boolean>();
const prueba: boolean = ((process.env.TEST_MODE !== undefined) && (process.env.TEST_MODE == 'true')) ? true : false;

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
    }
];
const adminTools: any[] = [
    ...tools,
    {
        type: 'function',
        function: {
            name: 'clean_chat',
            description: 'Clear message history for a specific user (only the following users can do this: ' + usuariosAdministradores.join(', ') + ' )',
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
            description: 'Clear message history for all users (only the following users can do this: ' + usuariosAdministradores.join(', ') + ' )'
        }
    }
];

const instructionsFile: string = (process.env.INSTRUCTIONS !== undefined) ? process.env.INSTRUCTIONS : 'instrucciones.txt';
const instructionsFileContent: string = existsSync(instructionsFile) ? readFileSync(instructionsFile, 'utf8') : '';
const instructions: string = ((instructionsFileContent !== '') ? instructionsFileContent : 'You are an assistant') + `
\n\nCONFIRMATION INSTRUCTIONS:\n
- Do NOT use 'functions' unless the client confirms or says EXPLICITLY: 'yes I confirm', 'I want to confirm' or similar\n
- ALWAYS ask: 'Do you want to confirm?' before using the function.\n`;

const limpiarChatsActual = async (user: string) => {
    try {
        if (!resetHistory(user)) throw new Error('Error clearing message history');
        return 'Message history cleared successfully';
    } catch (error: any) {
        return error.message;
    }
};

const limpiarChats = async (user: string) => {
    try {
        if (!resetHistory(user)) throw new Error('Error clearing message history for ' + user);
        return 'Message history for ' + user + ' cleared successfully';
    } catch (error: any) {
        return error.message;
    }
};

const limpiarChatsTodos = async () => {
    try {
        if (!resetAllHistory()) throw new Error('Error clearing all message history');
        return 'All message history cleared successfully';
    } catch (error: any) {
        return error.message;
    }
};

const functionAttempts = async (functionAttempt: any) => {
    let attempts: number = 0;
    while (attempts < limiteFetch) {
        try {
            return await functionAttempt();
        } catch (error: any) {
            attempts++;
            if (attempts < limiteFetch) await new Promise(resolve => setTimeout(resolve, limiteTiempo));
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

client.once('ready', () => {
    console.error('The Bot is ready!');
});

client.on('qr', (qr: string) => {
    qrcode.generate(qr, { small: true });
});

client.on('message_create', async (message: Message) => {
    const messageText: string = message.body.trim();
    let media: MessageMedia | null = null;
    if (message.hasMedia) media = await message.downloadMedia();
    const currentChat: Chat = await message.getChat();
    if ((!prueba && message.fromMe) || currentChat.isGroup || message.isStatus || (message.to === message.from) || (!media && messageText === '')) return;
    const contact: any = await client.getContactLidAndPhone([message.from]);
    const user: string = contact?.[0]?.pn ?? message.from.split('@')[0];
    const sesionActual: number | boolean = sesiones.get(user) ?? false;
    try {
        if (sesionActual) throw new Error('Responding to previous message. Please wait before sending a new message');
        sesiones.set(user, true);
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
            formData.append('model', modeloApiAudioOpenai);
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
        } else if (media && media.mimetype.startsWith('image/') && modeloSoportaImagen) {
            content.push({
                type: 'image_url',
                image_url: {
                    url: 'data:' + media.mimetype + ';base64,' + media.data
                }
            });
        }
        if (content.length === 0) return;
        messages.push({ role: 'user', content });

        const currentTools: any[] = usuariosAdministradores.includes(user) ? adminTools : tools;
        let currentIteration: number = 0,
            finalResponseContent: string | null = null,
            toolCalled: string | null = null;

        while (currentIteration < limiteHerramientas) {
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
                        model: modeloApiOpenai,
                        messages,
                        tools: currentTools,
                        tool_choice: 'auto',
                        max_completion_tokens: limiteTokensOpenai
                    })
                });
                if (!response.ok) throw new Error();
                data = await response.json();
                if (!data || (data.error && data.error.message && data.error.message.startsWith('Rate limit reached for model'))) throw new Error();
            });

            if (toolCalled) {
                resetHistory(user);
                if (!data || data.error || !data.choices) throw new Error(toolCalled);
            }
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

            toolCalled = 'Function executed successfully 😊';
            for (const toolCall of toolCalls) {
                const functionName: string = toolCall.function.name ?? '';
                const functionArgs: any = JSON.parse(toolCall.function.arguments) ?? null;
                let functionResponse: string = 'Failed function response';
                if (functionName == 'clean_current_chat') {
                    functionResponse = await limpiarChatsActual(user);
                } else if (usuariosAdministradores.includes(user)) {
                    if (functionName == 'clean_chat') {
                        functionResponse = await limpiarChats(functionArgs.user);
                    } else if (functionName == 'clean_all_chats') {
                        functionResponse = await limpiarChatsTodos();
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
        if (prueba) console.error(error);
        saveHistory(user, 'assistant', error.message, '', '');
        await client.sendMessage(message.from, error.message);
    }
    if (!sesionActual) sesiones.delete(user);
});

client.initialize();