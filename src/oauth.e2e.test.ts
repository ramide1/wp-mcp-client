/**
 * End to end test of the interactive OAuth 2.1 flow (authorization code + PKCE)
 * against a mock authorization server.
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MCPClientManager } from './mcp';
import { handleAdminCommand } from './commands';
import { startTestOAuthServer, type TestOAuthServer } from './test-support/oauth-test-server';

const tempDirs: string[] = [];
const servers: TestOAuthServer[] = [];

const createManager = (mcpUrl: string, tokenFile: string): MCPClientManager => {
    const dir = mkdtempSync(join(tmpdir(), 'oauth-e2e-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'mcp-servers.json');
    writeFileSync(configPath, JSON.stringify({
        servers: [
            {
                name: 'remote',
                type: 'streamable-http',
                url: mcpUrl,
                enabled: true,
                oauth: {
                    grant: 'authorization_code',
                    redirectUri: 'http://localhost:9999/callback',
                    dynamicRegistration: true,
                    scope: 'read',
                    tokenFile
                }
            }
        ]
    }), 'utf8');
    return new MCPClientManager(configPath);
};

afterEach(async () => {
    while (servers.length > 0) {
        const server = servers.pop();
        if (server) await server.stop();
    }
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) rmSync(dir, { recursive: true, force: true });
    }
});

describe('oauth: authorization code flow', () => {
    test('the first call asks for the authorization and reports the URL', async () => {
        const server = await startTestOAuthServer();
        servers.push(server);
        const dir = mkdtempSync(join(tmpdir(), 'oauth-e2e-'));
        tempDirs.push(dir);
        const manager = createManager(server.mcpUrl, join(dir, 'oauth.json'));

        await expect(manager.callTool('remote', 'whoami', {})).rejects.toThrow(/requires OAuth authorization/);

        const authorizationUrl = manager.getAuthorizationUrl('remote');
        expect(authorizationUrl).toBeDefined();
        expect(authorizationUrl).toContain('/authorize');
        expect(authorizationUrl).toContain('code_challenge=');
        expect(authorizationUrl).toContain('code_challenge_method=S256');
        expect(authorizationUrl).toContain('response_type=code');

        // The protected resource metadata was discovered (RFC 9728)
        expect(server.mcpRequests.some(request => request.path === '/.well-known/oauth-protected-resource')).toBe(true);
        // The authorization server metadata was discovered (RFC 8414)
        expect(server.asRequests.some(request => request.path === '/.well-known/oauth-authorization-server')).toBe(true);
        // The client was registered dynamically (RFC 7591)
        expect(server.asRequests.some(request => request.path === '/register')).toBe(true);

        await manager.disconnectAll();
    });

    test('the flow completes when the user authorizes and the code is delivered', async () => {
        const server = await startTestOAuthServer();
        servers.push(server);
        const dir = mkdtempSync(join(tmpdir(), 'oauth-e2e-'));
        tempDirs.push(dir);
        const tokenFile = join(dir, 'oauth.json');
        const manager = createManager(server.mcpUrl, tokenFile);

        // 1. The first call fails and the bot asks for the authorization
        await expect(manager.callTool('remote', 'whoami', {})).rejects.toThrow(/requires OAuth authorization/);
        const authorizationUrl = manager.getAuthorizationUrl('remote');
        expect(authorizationUrl).toBeDefined();

        // 2. The user opens the URL and is redirected to the callback with a code
        const redirect = await fetch(authorizationUrl!, { redirect: 'manual' });
        expect(redirect.status).toBe(302);
        const location = new URL(redirect.headers.get('Location') ?? '');
        const code = location.searchParams.get('code');
        expect(code).toBeTruthy();
        expect(location.searchParams.get('state')).toBeTruthy();

        // 3. The operator delivers the code to the bot
        await manager.completeAuthorization('remote', code!);

        // 4. The next call is authenticated and reaches the tool
        const result = await manager.callTool('remote', 'whoami', {});
        expect(result.content?.[0]?.text).toBe('authorized caller');

        // The token was persisted and reused
        expect(server.mcpRequests.some(request => request.headers['authorization'] === 'Bearer test-access-token')).toBe(true);
        expect(existsSync(tokenFile)).toBe(true);

        await manager.disconnectAll();
    });

    test('the token is reused after the manager is recreated', async () => {
        const server = await startTestOAuthServer();
        servers.push(server);
        const dir = mkdtempSync(join(tmpdir(), 'oauth-e2e-'));
        tempDirs.push(dir);
        const tokenFile = join(dir, 'oauth.json');

        const first = createManager(server.mcpUrl, tokenFile);
        await expect(first.callTool('remote', 'whoami', {})).rejects.toThrow(/requires OAuth authorization/);
        const authorizationUrl = first.getAuthorizationUrl('remote');
        const redirect = await fetch(authorizationUrl!, { redirect: 'manual' });
        const code = new URL(redirect.headers.get('Location') ?? '').searchParams.get('code');
        await first.completeAuthorization('remote', code!);
        await first.disconnectAll();

        // A new manager reads the persisted token and connects without asking again
        const second = createManager(server.mcpUrl, tokenFile);
        const result = await second.callTool('remote', 'whoami', {});
        expect(result.content?.[0]?.text).toBe('authorized caller');
        expect(second.getAuthorizationUrl('remote')).toBeUndefined();

        await second.disconnectAll();
    });

    test('the client credentials flow does not need any interaction', async () => {
        const server = await startTestOAuthServer();
        servers.push(server);
        const dir = mkdtempSync(join(tmpdir(), 'oauth-e2e-'));
        tempDirs.push(dir);
        const configPath = join(dir, 'mcp-servers.json');
        writeFileSync(configPath, JSON.stringify({
            servers: [{
                name: 'remote',
                type: 'streamable-http',
                url: server.mcpUrl,
                enabled: true,
                oauth: {
                    grant: 'client_credentials',
                    clientId: server.serviceClientId,
                    clientSecret: server.serviceClientSecret,
                    tokenFile: join(dir, 'oauth.json')
                }
            }]
        }), 'utf8');
        const manager = new MCPClientManager(configPath);

        // The flow is completely automatic: a token is fetched and the call succeeds
        const result = await manager.callTool('remote', 'whoami', {});
        expect(result.content?.[0]?.text).toBe('authorized caller');

        // The metadata was discovered (RFC 8414) and the token was requested
        // with the `client_credentials` grant
        expect(server.asRequests.some(request => request.path === '/.well-known/oauth-authorization-server')).toBe(true);
        const tokenRequest = server.asRequests.find(request => request.path === '/token');
        expect(tokenRequest).toBeDefined();
        expect(tokenRequest!.body?.grant_type).toBe('client_credentials');

        // The service token was used against the MCP server
        expect(server.mcpRequests.some(request => request.headers['authorization'] === `Bearer ${server.serviceAccessToken}`)).toBe(true);

        // The user is never asked to authorize anything
        expect(manager.getAuthorizationUrl('remote')).toBeUndefined();

        await manager.disconnectAll();
    });

    test('the client credentials flow fails with an invalid secret', async () => {
        const server = await startTestOAuthServer();
        servers.push(server);
        const dir = mkdtempSync(join(tmpdir(), 'oauth-e2e-'));
        tempDirs.push(dir);
        const configPath = join(dir, 'mcp-servers.json');
        writeFileSync(configPath, JSON.stringify({
            servers: [{
                name: 'remote',
                type: 'streamable-http',
                url: server.mcpUrl,
                enabled: true,
                oauth: {
                    grant: 'client_credentials',
                    clientId: server.serviceClientId,
                    clientSecret: 'wrong-secret',
                    tokenFile: join(dir, 'oauth.json')
                }
            }]
        }), 'utf8');
        const manager = new MCPClientManager(configPath);

        await expect(manager.callTool('remote', 'whoami', {})).rejects.toThrow();
        expect(manager.getAuthorizationUrl('remote')).toBeUndefined();

        await manager.disconnectAll();
    });
});

describe('oauth: the /oauth admin command', () => {
    test('shows the pending URL and finishes the flow with the code', async () => {
        const server = await startTestOAuthServer();
        servers.push(server);
        const dir = mkdtempSync(join(tmpdir(), 'oauth-e2e-'));
        tempDirs.push(dir);
        const manager = createManager(server.mcpUrl, join(dir, 'oauth.json'));

        const dependencies = {
            getAuthorizationUrl: (serverName: string) => manager.getAuthorizationUrl(serverName),
            completeAuthorization: (serverName: string, code: string) => manager.completeAuthorization(serverName, code)
        };

        // 1. The first call starts the flow and asks for the authorization
        await expect(manager.callTool('remote', 'whoami', {})).rejects.toThrow(/requires OAuth authorization/);

        // 2. The admin asks for the URL of the pending flow
        const urlAnswer = await handleAdminCommand('/oauth remote', dependencies);
        expect(urlAnswer).toBeDefined();
        expect(urlAnswer).toContain('/authorize');
        expect(urlAnswer).toContain('code_challenge=');

        // 3. The user authorizes and the admin sends the code
        const redirect = await fetch(manager.getAuthorizationUrl('remote')!, { redirect: 'manual' });
        const code = new URL(redirect.headers.get('Location') ?? '').searchParams.get('code');
        expect(code).toBeTruthy();

        const codeAnswer = await handleAdminCommand(`/oauth remote ${code}`, dependencies);
        expect(codeAnswer).toContain('Authorization completed for "remote"');

        // 4. The next call is authenticated
        const result = await manager.callTool('remote', 'whoami', {});
        expect(result.content?.[0]?.text).toBe('authorized caller');

        await manager.disconnectAll();
    });

    test('explains that there is nothing pending', async () => {
        const server = await startTestOAuthServer();
        servers.push(server);
        const dir = mkdtempSync(join(tmpdir(), 'oauth-e2e-'));
        tempDirs.push(dir);
        const manager = createManager(server.mcpUrl, join(dir, 'oauth.json'));

        const answer = await handleAdminCommand('/oauth remote', {
            getAuthorizationUrl: (serverName: string) => manager.getAuthorizationUrl(serverName),
            completeAuthorization: (serverName: string, code: string) => manager.completeAuthorization(serverName, code)
        });
        expect(answer).toContain('No pending authorization for "remote"');

        await manager.disconnectAll();
    });
});
