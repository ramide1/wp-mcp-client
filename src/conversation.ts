/**
 * Pure helpers used by the conversation loop.
 *
 * They are kept in a dedicated module (instead of `main.ts`) so they can be
 * unit tested without booting the WhatsApp client.
 */

import type { McpToolResult } from './interface';

/** A row of the chat history table. */
export interface HistoryEntry {
    role: string;
    text_content?: string | null;
    tool_call_id?: string | null;
    function_name?: string | null;
    [key: string]: unknown;
}

/**
 * Rebuild the messages array of the API from the rows of the history table.
 *
 * The encoding is quirky on purpose (see AGENTS.md):
 * - the tool calls of an assistant message are stored as JSON in `function_name`
 * - the result of a tool is stored in `text_content` with its `tool_call_id`
 *
 * A malformed `function_name` must not break the reconstruction: the text of
 * the assistant message is used as a fallback.
 */
export const reconstructHistory = (entries: HistoryEntry[]): any[] => {
    const messages: any[] = [];
    for (const entry of entries) {
        if (entry.role === 'tool') {
            messages.push({
                role: 'tool',
                content: entry.text_content,
                tool_call_id: entry.tool_call_id,
                name: entry.function_name
            });
        } else if (entry.role === 'assistant' && entry.function_name) {
            try {
                const toolCalls = JSON.parse(entry.function_name);
                const message: any = { role: 'assistant' };
                if (entry.text_content) message.content = entry.text_content;
                if (Array.isArray(toolCalls) && toolCalls.length > 0) message.tool_calls = toolCalls;
                messages.push(message);
            } catch {
                if (entry.text_content) messages.push({ role: 'assistant', content: entry.text_content });
            }
        } else {
            if (entry.text_content) messages.push({ role: entry.role, content: entry.text_content });
        }
    }
    return messages;
};

/**
 * Extract readable text from an MCP tool call result.
 * Handles text, image, audio, and resource content types.
 * Falls back to JSON serialization when no text content is found.
 */
export const extractMcpResultText = (result: McpToolResult): string => {
    let textContent = '';
    if (result && result.content && Array.isArray(result.content)) {
        for (const content of result.content) {
            if (content.type === 'text' && typeof content.text === 'string') {
                textContent += content.text + '\n';
            } else if (content.type === 'image' || content.type === 'audio') {
                textContent += `[${content.type} content not displayed in text chat]\n`;
            } else if (content.type === 'resource') {
                const res = content.resource as { uri?: string } | undefined;
                textContent += `[Resource: ${res?.uri || 'unknown'}]\n`;
            }
        }
    }
    textContent = textContent.trimEnd();
    if (textContent === '') {
        // Tools with an outputSchema may return structured content instead of text
        textContent = (result && result.structuredContent !== undefined && result.structuredContent !== null)
            ? JSON.stringify(result.structuredContent)
            : JSON.stringify(result);
    }
    return textContent;
};

/**
 * Extract readable text from the contents of a resource.
 */
export const extractResourceText = (result: unknown): string => {
    const contents = (result as { contents?: Array<{ uri?: string; mimeType?: string; text?: string; blob?: string }> })?.contents;
    if (!Array.isArray(contents)) return JSON.stringify(result);
    let text = '';
    for (const item of contents) {
        text += `[${item.uri ?? 'unknown'}${item.mimeType ? ` (${item.mimeType})` : ''}]\n`;
        if (typeof item.text === 'string') text += item.text + '\n';
        else if (typeof item.blob === 'string') text += `[binary content: ${item.blob.length} base64 chars]\n`;
    }
    return text.trimEnd() || JSON.stringify(result);
};

/**
 * Summarize the arguments of a tool call so the user can decide whether to
 * approve it. Secrets are never shown.
 */
export const summarizeToolArgs = (args: unknown): string => {
    try {
        const text = JSON.stringify(args, null, 2) ?? '';
        const redacted = text.replace(
            /("(?:[\w.-]*(?:token|secret|password|api[_-]?key|authorization)[\w.-]*)"\s*:\s*)"[^"]*"/gi,
            '$1"[redacted]"'
        );
        return redacted.length > 1200 ? redacted.substring(0, 1200) + '\n... [truncated]' : redacted;
    } catch {
        return '(arguments could not be displayed)';
    }
};
