import { describe, expect, test } from 'bun:test';
import { ConfirmationManager, parseConfirmationAnswer } from './confirm';

describe('parseConfirmationAnswer', () => {
    test('accepts the common affirmative answers', () => {
        for (const answer of ['si', 'sí', 'SI', 'yes', 'Yes', 'ok', 'confirmo', 'confirmar', 'adelante', 'dale', 'hazlo', 'go ahead']) {
            expect(parseConfirmationAnswer(answer)).toBe('approved');
        }
    });

    test('accepts the common negative answers', () => {
        for (const answer of ['no', 'No', 'nunca', 'cancel', 'cancela', 'rechazar', 'stop', 'no gracias']) {
            expect(parseConfirmationAnswer(answer)).toBe('rejected');
        }
    });

    test('ignores accents and punctuation', () => {
        expect(parseConfirmationAnswer('Sí, por favor!')).toBe('approved');
        expect(parseConfirmationAnswer('No...')).toBe('rejected');
    });

    test('returns undefined when the answer is ambiguous or empty', () => {
        expect(parseConfirmationAnswer('')).toBeUndefined();
        expect(parseConfirmationAnswer('maybe')).toBeUndefined();
        expect(parseConfirmationAnswer('sí pero no')).toBeUndefined();
    });
});

describe('ConfirmationManager.requiresConfirmation', () => {
    test('requires confirmation for every MCP tool when no pattern is configured', () => {
        const manager = new ConfirmationManager({ patterns: '' });
        expect(manager.requiresConfirmation('filesystem__write_file')).toBe(true);
        expect(manager.requiresConfirmation('any__tool')).toBe(true);
    });

    test('never requires confirmation for the read-only helpers', () => {
        const manager = new ConfirmationManager({ patterns: '' });
        expect(manager.requiresConfirmation('search_tools')).toBe(false);
        expect(manager.requiresConfirmation('get_tool_details')).toBe(false);
        expect(manager.requiresConfirmation('search_available_servers')).toBe(false);
        expect(manager.requiresConfirmation('list_resources')).toBe(false);
        expect(manager.requiresConfirmation('read_resource')).toBe(false);
        expect(manager.requiresConfirmation('list_prompts')).toBe(false);
        expect(manager.requiresConfirmation('get_prompt')).toBe(false);
    });

    test('only requires confirmation for the configured patterns', () => {
        const manager = new ConfirmationManager({ patterns: 'delete*, *__write_*' });
        expect(manager.requiresConfirmation('filesystem__delete_file')).toBe(true);
        expect(manager.requiresConfirmation('filesystem__write_file')).toBe(true);
        expect(manager.requiresConfirmation('filesystem__read_file')).toBe(false);
        expect(manager.requiresConfirmation('remove')).toBe(false);
    });

    test('an empty pattern list disables the confirmation', () => {
        const manager = new ConfirmationManager({ patterns: 'none' });
        expect(manager.requiresConfirmation('filesystem__write_file')).toBe(false);
        expect(manager.enabled).toBe(false);
    });

    test('"none" disables the confirmation even for a tool named "none"', () => {
        const manager = new ConfirmationManager({ patterns: 'none' });
        expect(manager.requiresConfirmation('server__none')).toBe(false);
        expect(manager.requiresConfirmation('none')).toBe(false);
    });

    test('reports whether the confirmation is enabled', () => {
        expect(new ConfirmationManager({ patterns: '' }).enabled).toBe(true);
        expect(new ConfirmationManager({ patterns: '*' }).enabled).toBe(true);
    });
});

describe('ConfirmationManager.request', () => {
    test('resolves as approved when the user answers yes', async () => {
        const manager = new ConfirmationManager({ patterns: '*' });
        const questions: string[] = [];

        const pending = manager.request('user1', { toolName: 'fs__write', args: { path: 'a' }, summary: '{}' }, async (q) => {
            questions.push(q);
        });

        expect(manager.hasPending('user1')).toBe(true);
        expect(manager.getPending('user1')?.request.toolName).toBe('fs__write');

        const outcome = manager.resolve('user1', 'sí');
        expect(outcome).toBe('approved');
        expect(await pending).toBe('approved');
        expect(manager.hasPending('user1')).toBe(false);
        expect(questions[0]).toContain('fs__write');
    });

    test('resolves as rejected when the user answers no', async () => {
        const manager = new ConfirmationManager({ patterns: '*' });
        const pending = manager.request('user1', { toolName: 'fs__write', args: {}, summary: '{}' }, async () => { });

        expect(manager.resolve('user1', 'no')).toBe('rejected');
        expect(await pending).toBe('rejected');
    });

    test('keeps the request pending when the answer is not understood', async () => {
        const manager = new ConfirmationManager({ patterns: '*' });
        const pending = manager.request('user1', { toolName: 'fs__write', args: {}, summary: '{}' }, async () => { });

        expect(manager.resolve('user1', 'hmm')).toBeUndefined();
        expect(manager.hasPending('user1')).toBe(true);

        manager.resolve('user1', 'yes');
        expect(await pending).toBe('approved');
    });

    test('times out when the user does not answer', async () => {
        const manager = new ConfirmationManager({ patterns: '*', timeoutSeconds: 0.05 });
        const pending = manager.request('user1', { toolName: 'fs__write', args: {}, summary: '{}' }, async () => { });
        expect(await pending).toBe('timeout');
        expect(manager.hasPending('user1')).toBe(false);
    });

    test('a new request cancels the previous one', async () => {
        const manager = new ConfirmationManager({ patterns: '*' });
        const first = manager.request('user1', { toolName: 'a', args: {}, summary: '{}' }, async () => { });
        const second = manager.request('user1', { toolName: 'b', args: {}, summary: '{}' }, async () => { });

        expect(await first).toBe('cancelled');
        expect(manager.getPending('user1')?.request.toolName).toBe('b');
        manager.cancel('user1');
        expect(await second).toBe('cancelled');
    });

    test('does nothing when there is no pending request', () => {
        const manager = new ConfirmationManager({ patterns: '*' });
        expect(manager.resolve('nobody', 'yes')).toBeUndefined();
        expect(manager.pendingCount).toBe(0);
    });
});
