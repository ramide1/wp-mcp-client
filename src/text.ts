/**
 * Pure text helpers used to keep the LLM context within budget.
 * Kept in a dedicated module (instead of `main.ts`) so they can be unit tested.
 */

import { createLogger } from './logger';

const log = createLogger('context');

/**
 * Rough token estimation: ~4 chars per token for Latin text, ~1 token per CJK character.
 * Good enough for truncation decisions; not for billing.
 */
export const estimateTokens = (text: string): number => {
    if (!text) return 0;
    let cjkChars = 0;
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        if (
            (code >= 0x3040 && code <= 0x30ff) || // kana
            (code >= 0x3400 && code <= 0x4dbf) || // CJK extension A
            (code >= 0x4e00 && code <= 0x9fff) || // CJK unified ideographs
            (code >= 0xac00 && code <= 0xd7af) || // hangul syllables
            (code >= 0xf900 && code <= 0xfaff) // CJK compatibility ideographs
        ) {
            cjkChars++;
        }
    }
    const latinChars = text.length - cjkChars;
    return Math.ceil(cjkChars + latinChars / 4);
};

/**
 * Estimate tokens for a single message object.
 * Content and tool calls are both counted: an assistant message can carry
 * text and tool calls at the same time.
 */
export const estimateMessageTokens = (msg: any): number => {
    let tokens = 0;
    if (typeof msg.content === 'string') {
        tokens += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
        tokens += msg.content.reduce((sum: number, part: any) => {
            if (part.type === 'text') return sum + estimateTokens(part.text);
            if (part.type === 'image_url') return sum + 1000; // rough estimate for images
            return sum;
        }, 0);
    }
    // tool_calls in assistant messages
    if (Array.isArray(msg.tool_calls)) {
        tokens += msg.tool_calls.reduce((sum: number, tc: any) => {
            return sum + estimateTokens(tc.function?.name ?? '') + estimateTokens(tc.function?.arguments ?? '');
        }, 0);
    }
    return tokens;
};

/**
 * Truncate the messages array to fit within a token budget.
 * Keeps the system message (index 0) and drops the oldest non-system messages first.
 * Never drops tool results that are referenced by pending assistant tool_calls.
 */
export const truncateMessages = (messages: any[], maxTokens: number): any[] => {
    let totalTokens = messages.reduce((sum: number, msg: any) => sum + estimateMessageTokens(msg), 0);
    if (totalTokens <= maxTokens) return messages;

    // Always keep the system message (index 0)
    const systemMsg = messages[0];
    const rest = messages.slice(1);

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
        if (msg.role === 'tool' && msg.tool_call_id && referencedToolCallIds.has(msg.tool_call_id)) {
            dropIndex++;
            continue;
        }
        totalTokens -= estimateMessageTokens(msg);
        dropIndex++;
    }

    const truncated = [systemMsg, ...rest.slice(dropIndex)];
    if (dropIndex > 0) {
        log.debug('Truncated messages', { dropped: dropIndex, estimatedTokens: totalTokens });
    }
    return truncated;
};

/**
 * Smart truncation that preserves JSON structure when possible.
 * For plain text: truncates at word boundary with ellipsis.
 * For JSON: pretty-prints and truncates with a structural hint.
 */
export const truncateResult = (result: string, maxLength: number): string => {
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
 * URLs that point to a media file. Only these are sent as WhatsApp attachments;
 * regular links stay in the text of the answer.
 */
const mediaUrlPattern = (): RegExp =>
    /(https?:\/\/[^\s]+?\.(?:png|jpe?g|gif|webp|bmp|svg|mp4|m4v|mov|webm|mp3|m4a|ogg|opus|wav|pdf)(?:\?[^\s]*)?)/gi;

/**
 * Extract the media URLs contained in a text.
 */
export const extractMediaUrls = (text: string): string[] => text.match(mediaUrlPattern()) ?? [];

/**
 * Remove the media URLs from a text, keeping the rest readable.
 */
export const stripMediaUrls = (text: string): string =>
    text.replace(mediaUrlPattern(), '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
