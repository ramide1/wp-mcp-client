import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { McpOAuthProvider, createOAuthProvider } from './oauth';

const tempDirs: string[] = [];

const makeStorePath = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'oauth-test-'));
    tempDirs.push(dir);
    return join(dir, 'oauth.json');
};

afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) rmSync(dir, { recursive: true, force: true });
    }
});

describe('McpOAuthProvider', () => {
    test('uses the configured client id and secret', () => {
        const provider = new McpOAuthProvider({
            serverName: 'remote',
            serverUrl: 'https://mcp.example.com',
            clientId: 'client-1',
            clientSecret: 'secret-1',
            grant: 'client_credentials',
            tokenFile: makeStorePath()
        });

        expect(provider.clientInformation()).toEqual({ client_id: 'client-1', client_secret: 'secret-1' });
        expect(provider.redirectUrl).toBeUndefined();
    });

    test('builds the client_credentials token request', () => {
        const provider = new McpOAuthProvider({
            serverName: 'remote',
            serverUrl: 'https://mcp.example.com',
            clientId: 'client-1',
            clientSecret: 'secret-1',
            scope: 'read write',
            grant: 'client_credentials',
            tokenFile: makeStorePath()
        });

        const params = provider.prepareTokenRequest();
        expect(params?.get('grant_type')).toBe('client_credentials');
        expect(params?.get('scope')).toBe('read write');
    });

    test('persists the tokens and the client information', () => {
        const storePath = makeStorePath();
        const provider = new McpOAuthProvider({
            serverName: 'remote',
            serverUrl: 'https://mcp.example.com',
            clientId: 'client-1',
            grant: 'client_credentials',
            tokenFile: storePath
        });

        provider.saveTokens({ access_token: 'at-1', token_type: 'Bearer' });
        provider.saveClientInformation({ client_id: 'client-1', client_secret: 'secret-1' });

        expect(existsSync(storePath)).toBe(true);

        const reloaded = new McpOAuthProvider({
            serverName: 'remote',
            serverUrl: 'https://mcp.example.com',
            clientId: 'client-1',
            grant: 'client_credentials',
            tokenFile: storePath
        });
        expect(reloaded.tokens()?.access_token).toBe('at-1');
        expect(reloaded.hasTokens).toBe(true);
    });

    test('invalidates the credentials on demand', () => {
        const provider = new McpOAuthProvider({
            serverName: 'remote',
            serverUrl: 'https://mcp.example.com',
            clientId: 'client-1',
            grant: 'client_credentials',
            tokenFile: makeStorePath()
        });

        provider.saveTokens({ access_token: 'at-1', token_type: 'Bearer' });
        provider.invalidateCredentials('tokens');
        expect(provider.tokens()).toBeUndefined();
    });

    test('notifies the caller when an authorization is required', () => {
        const urls: string[] = [];
        const provider = new McpOAuthProvider({
            serverName: 'remote',
            serverUrl: 'https://mcp.example.com',
            redirectUri: 'http://localhost/callback',
            grant: 'authorization_code',
            tokenFile: makeStorePath(),
            onAuthorizationRequired: (url) => urls.push(url)
        });

        provider.redirectToAuthorization(new URL('https://auth.example.com/authorize?client_id=1'));
        expect(urls).toHaveLength(1);
        expect(provider.authorizationUrl).toContain('authorize');
    });

    test('reports a missing PKCE verifier instead of failing silently', () => {
        const provider = new McpOAuthProvider({
            serverName: 'remote',
            serverUrl: 'https://mcp.example.com',
            redirectUri: 'http://localhost/callback',
            grant: 'authorization_code',
            tokenFile: makeStorePath()
        });
        expect(() => provider.codeVerifier()).toThrow(/code verifier/i);
    });

    test('generates a fresh state for every authorization request', () => {
        const provider = new McpOAuthProvider({
            serverName: 'remote',
            serverUrl: 'https://mcp.example.com',
            redirectUri: 'http://localhost/callback',
            grant: 'authorization_code',
            tokenFile: makeStorePath()
        });
        expect(provider.state()).not.toBe(provider.state());
    });
});

describe('createOAuthProvider', () => {
    test('returns undefined when the server does not declare OAuth', () => {
        expect(createOAuthProvider({ serverName: 'remote', serverUrl: 'https://mcp.example.com' })).toBeUndefined();
    });

    test('creates a provider when the server declares OAuth', () => {
        const provider = createOAuthProvider({
            serverName: 'remote',
            serverUrl: 'https://mcp.example.com',
            clientId: 'client-1',
            tokenFile: makeStorePath()
        });
        expect(provider).toBeInstanceOf(McpOAuthProvider);
    });
});
