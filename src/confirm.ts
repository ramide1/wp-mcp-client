/**
 * Human-in-the-loop confirmation for tool execution.
 *
 * The system prompt asks the model to request confirmation, but a prompt is not
 * an enforcement mechanism: the model can skip it. This module enforces the
 * rule at the host level — a tool call that requires confirmation is not
 * dispatched until the user explicitly approves it in the chat.
 *
 * Configuration (environment variables):
 * - `CONFIRM_TOOLS`: comma separated glob patterns of the tools that require
 *   confirmation (`*` wildcards). When empty, every MCP tool call requires
 *   confirmation while the read-only helpers stay exempt. The value `none`
 *   disables the confirmation for every tool.
 * - `CONFIRM_TIMEOUT`: seconds to wait for the user's answer (default: 120).
 */

import { secondsFromEnv } from './env';

export type ConfirmationOutcome = 'approved' | 'rejected' | 'timeout' | 'cancelled';

export interface ConfirmationRequest {
    /** Full tool name as exposed to the model (`server__tool`). */
    toolName: string;
    /** Arguments the model wants to pass. */
    args: unknown;
    /** Short human readable summary shown to the user. */
    summary: string;
}

export interface PendingConfirmation {
    request: ConfirmationRequest;
    createdAt: number;
}

export interface ConfirmationManagerOptions {
    /** Comma separated glob patterns. Empty means "all MCP tools". */
    patterns?: string;
    /** Seconds to wait for an answer. */
    timeoutSeconds?: number;
}

interface PendingEntry {
    request: ConfirmationRequest;
    resolve: (outcome: ConfirmationOutcome) => void;
    timer: ReturnType<typeof setTimeout>;
    createdAt: number;
}

/** Read-only helpers of the host: they never change any state and never need approval. */
const ALWAYS_EXEMPT = new Set([
    'search_tools',
    'get_tool_details',
    'search_available_servers',
    'list_resources',
    'read_resource',
    'list_prompts',
    'get_prompt'
]);

/** Value of CONFIRM_TOOLS that disables the confirmation completely. */
const DISABLE_VALUE = 'none';

const AFFIRMATIVE = new Set([
    'si', 'sii', 'siii', 'yes', 'yeah', 'y', 'ok', 'okay', 'okk',
    'confirmo', 'confirmar', 'confirmed', 'confirm',
    'adelante', 'dale', 'dales', 'hazlo', 'hecho', 'hecha',
    'do', 'doit', 'proceed', 'go', 'goahead', 'approved', 'approve'
]);

const NEGATIVE = new Set([
    'no', 'nope', 'nada', 'nunca', 'nel', 'negativo',
    'cancel', 'cancela', 'cancelar', 'cancelled',
    'rechaza', 'rechazar', 'rechazo', 'rejected', 'reject',
    'stop', 'para', 'parar', 'dont', 'thanks'
]);

const stripAccents = (text: string): string =>
    text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const tokenize = (text: string): string[] =>
    stripAccents(text.toLowerCase())
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(token => token.length > 0);

const globToRegExp = (pattern: string): RegExp => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
};

/**
 * Decide whether a message answers a confirmation request.
 * Returns `undefined` when the message does not clearly say yes or no.
 */
export const parseConfirmationAnswer = (text: string): 'approved' | 'rejected' | undefined => {
    const tokens = tokenize(text);
    if (tokens.length === 0) return undefined;

    const affirmative = tokens.some(token => AFFIRMATIVE.has(token));
    const negative = tokens.some(token => NEGATIVE.has(token));

    if (affirmative && !negative) return 'approved';
    if (negative && !affirmative) return 'rejected';
    return undefined;
};

/**
 * Message returned to the model when a tool call was not approved.
 */
export const confirmationRejectedMessage = (outcome: ConfirmationOutcome): string => {
    switch (outcome) {
        case 'rejected':
            return 'The tool was NOT executed: the user rejected the confirmation.';
        case 'timeout':
            return 'The tool was NOT executed: the confirmation expired before the user answered.';
        case 'cancelled':
            return 'The tool was NOT executed: the confirmation was cancelled.';
        default:
            return 'The tool was NOT executed.';
    }
};

/**
 * Manages the pending confirmation requests, one per user.
 */
export class ConfirmationManager {
    private readonly patterns: RegExp[];
    private readonly explicitPatterns: boolean;
    private readonly disabled: boolean;
    private readonly timeoutMs: number;
    private readonly pending = new Map<string, PendingEntry>();

    constructor(options: ConfirmationManagerOptions = {}) {
        const raw = (options.patterns ?? process.env.CONFIRM_TOOLS ?? '').trim();
        // "none" disables the confirmation for every tool, including a tool
        // that happens to be named "none".
        this.disabled = raw.toLowerCase() === DISABLE_VALUE;
        this.explicitPatterns = raw !== '' && !this.disabled;
        this.patterns = this.explicitPatterns
            ? raw.split(',').map(part => part.trim()).filter(part => part.length > 0).map(globToRegExp)
            : [];
        const seconds = options.timeoutSeconds ?? secondsFromEnv('CONFIRM_TIMEOUT', 120);
        this.timeoutMs = seconds * 1000;
    }

    /**
     * True when the confirmation mechanism can ask the user for approval.
     * When false, no tool ever requires confirmation.
     */
    public get enabled(): boolean {
        return !this.disabled;
    }

    /** True when the given tool needs an explicit confirmation from the user. */
    public requiresConfirmation(toolName: string): boolean {
        if (!toolName) return false;
        if (this.disabled) return false;
        const bare = toolName.includes('__') ? toolName.split('__').slice(1).join('__') : toolName;
        if (ALWAYS_EXEMPT.has(bare) || ALWAYS_EXEMPT.has(toolName)) return false;

        if (!this.explicitPatterns) return true;
        return this.patterns.some(pattern => pattern.test(toolName) || pattern.test(bare));
    }

    /** True when the user has a confirmation request waiting for an answer. */
    public hasPending(userId: string): boolean {
        return this.pending.has(userId);
    }

    /** The pending request of a user, if any. */
    public getPending(userId: string): PendingConfirmation | undefined {
        const entry = this.pending.get(userId);
        if (!entry) return undefined;
        return { request: entry.request, createdAt: entry.createdAt };
    }

    /** Number of pending requests (used by tests and diagnostics). */
    public get pendingCount(): number {
        return this.pending.size;
    }

    /**
     * Ask the user for confirmation and wait for the answer.
     *
     * @param userId Identifier of the user that must answer.
     * @param request Description of the pending call.
     * @param notify Callback used to send the question to the user.
     * @returns The outcome of the request.
     */
    public async request(
        userId: string,
        request: ConfirmationRequest,
        notify: (text: string) => Promise<void>
    ): Promise<ConfirmationOutcome> {
        // A second request for the same user cancels the first one.
        this.cancel(userId);

        return new Promise<ConfirmationOutcome>((resolve) => {
            const timer = setTimeout(() => {
                this.pending.delete(userId);
                resolve('timeout');
            }, this.timeoutMs);

            this.pending.set(userId, { request, resolve, timer, createdAt: Date.now() });

            const question =
                `Confirmación requerida\n\n` +
                `Herramienta: ${request.toolName}\n` +
                `${request.summary}\n\n` +
                `Responde "sí" para ejecutar o "no" para cancelar. ` +
                `La solicitud expira en ${Math.round(this.timeoutMs / 1000)} segundos.`;

            notify(question).catch(() => {
                // The user cannot be reached: treat it as a rejection.
                this.settle(userId, 'cancelled');
            });
        });
    }

    /**
     * Resolve a pending request with the user's answer.
     * Returns the outcome, or `undefined` when there was nothing pending or the
     * answer was not understood.
     */
    public resolve(userId: string, text: string): ConfirmationOutcome | undefined {
        const entry = this.pending.get(userId);
        if (!entry) return undefined;

        const answer = parseConfirmationAnswer(text);
        if (!answer) return undefined;

        this.settle(userId, answer);
        return answer;
    }

    /** Cancel a pending request without answering it. */
    public cancel(userId: string): void {
        const entry = this.pending.get(userId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(userId);
        entry.resolve('cancelled');
    }

    private settle(userId: string, outcome: ConfirmationOutcome): void {
        const entry = this.pending.get(userId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(userId);
        entry.resolve(outcome);
    }
}
