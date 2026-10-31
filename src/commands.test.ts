import { describe, expect, test } from 'bun:test';
import {
    parseAdminCommand,
    handleOAuthCommand,
    handleAdminCommand,
    OAUTH_USAGE,
    type AdminCommandDependencies
} from './commands';

/** Dependencies that record what the command did. */
const makeDependencies = (overrides: Partial<AdminCommandDependencies> = {}): {
    dependencies: AdminCommandDependencies;
    completed: Array<{ serverName: string; code: string }>;
} => {
    const completed: Array<{ serverName: string; code: string }> = [];
    const dependencies: AdminCommandDependencies = {
        getAuthorizationUrl: () => 'https://auth.example.com/authorize?client_id=abc',
        completeAuthorization: async (serverName: string, code: string) => {
            completed.push({ serverName, code });
        },
        ...overrides
    };
    return { dependencies, completed };
};

describe('parseAdminCommand', () => {
    test('parses the command without arguments', () => {
        expect(parseAdminCommand('/oauth')).toEqual({ name: 'oauth', serverName: '', code: undefined });
    });

    test('parses the command with the server name', () => {
        expect(parseAdminCommand('/oauth remote')).toEqual({ name: 'oauth', serverName: 'remote', code: undefined });
    });

    test('parses the command with the server name and the code', () => {
        expect(parseAdminCommand('/oauth remote abc123')).toEqual({ name: 'oauth', serverName: 'remote', code: 'abc123' });
    });

    test('keeps the spaces of the code', () => {
        const command = parseAdminCommand('/oauth remote abc 123');
        expect(command?.code).toBe('abc 123');
    });

    test('ignores the extra spaces', () => {
        expect(parseAdminCommand('  /oauth   remote   abc123  ')).toEqual({
            name: 'oauth', serverName: 'remote', code: 'abc123'
        });
    });

    test('ignores the messages that are not a command', () => {
        expect(parseAdminCommand('hello')).toBeUndefined();
        expect(parseAdminCommand('please /oauth remote')).toBeUndefined();
        expect(parseAdminCommand('')).toBeUndefined();
    });

    test('does not confuse a word that starts like the command', () => {
        expect(parseAdminCommand('/oauthfoo')).toBeUndefined();
        expect(parseAdminCommand('/oauth-server remote')).toBeUndefined();
    });
});

describe('handleOAuthCommand', () => {
    test('shows the usage when the server name is missing', async () => {
        const { dependencies } = makeDependencies();
        const answer = await handleOAuthCommand({ name: 'oauth', serverName: '' }, dependencies);
        expect(answer).toBe(OAUTH_USAGE);
    });

    test('returns the authorization URL of the pending flow', async () => {
        const { dependencies } = makeDependencies();
        const answer = await handleOAuthCommand({ name: 'oauth', serverName: 'remote' }, dependencies);
        expect(answer).toContain('https://auth.example.com/authorize?client_id=abc');
        expect(answer).toContain('remote');
    });

    test('explains that there is nothing to authorize yet', async () => {
        const { dependencies } = makeDependencies({ getAuthorizationUrl: () => undefined });
        const answer = await handleOAuthCommand({ name: 'oauth', serverName: 'remote' }, dependencies);
        expect(answer).toContain('No pending authorization for "remote"');
    });

    test('finishes the authorization with the code', async () => {
        const { dependencies, completed } = makeDependencies();
        const answer = await handleOAuthCommand(
            { name: 'oauth', serverName: 'remote', code: 'abc123' },
            dependencies
        );
        expect(completed).toEqual([{ serverName: 'remote', code: 'abc123' }]);
        expect(answer).toBe('Authorization completed for "remote". The next tool call will reconnect the server.');
    });

    test('reports the failure of the authorization', async () => {
        const { dependencies } = makeDependencies({
            completeAuthorization: async () => { throw new Error('invalid_grant'); }
        });
        const answer = await handleOAuthCommand(
            { name: 'oauth', serverName: 'remote', code: 'bad' },
            dependencies
        );
        expect(answer).toBe('Could not complete the authorization of "remote": invalid_grant');
    });
});

describe('handleAdminCommand', () => {
    test('returns undefined when the message is not a command', async () => {
        const { dependencies } = makeDependencies();
        expect(await handleAdminCommand('hello there', dependencies)).toBeUndefined();
    });

    test('handles the oauth command', async () => {
        const { dependencies, completed } = makeDependencies();
        const answer = await handleAdminCommand('/oauth remote abc123', dependencies);
        expect(completed).toEqual([{ serverName: 'remote', code: 'abc123' }]);
        expect(answer).toContain('Authorization completed');
    });
});
