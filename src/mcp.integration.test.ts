/**
 * Integration tests: the client is connected to a real MCP server served over
 * Streamable HTTP. They exercise the actual protocol (JSON-RPC over HTTP),
 * not a mock.
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MCPClientManager } from './mcp';
import { startTestMcpServer, type TestMcpServer } from './test-support/mcp-test-server';

const tempDirs: string[] = [];
const servers: TestMcpServer[] = [];

/**
 * Wait until a condition is met. The notifications travel through an SSE
 * stream, so their delivery is asynchronous and cannot be awaited directly.
 */
const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs: number = 15000): Promise<void> => {
    const start = Date.now();
    while (true) {
        if (await predicate()) return;
        if (Date.now() - start > timeoutMs) {
            throw new Error(`Timed out after ${timeoutMs}ms waiting for the condition`);
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
};

const createManager = (serverUrl: string, extra: Record<string, unknown> = {}): MCPClientManager => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-integration-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'mcp-servers.json');
    writeFileSync(configPath, JSON.stringify({
        servers: [
            {
                name: 'test',
                type: 'streamable-http',
                url: serverUrl,
                enabled: true,
                ...extra
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

describe('integration: connection and discovery', () => {
    test('connects, lists the tools of every page and calls them', async () => {
        const server = await startTestMcpServer();
        servers.push(server);
        const manager = createManager(server.url);

        const details = await manager.getToolDetails('test', 'alpha');
        expect(details.name).toBe('alpha');

        // The pagination cursor is followed: the tool of the second page is found
        const gamma = await manager.getToolDetails('test', 'gamma');
        expect(gamma.name).toBe('gamma');

        const result = await manager.callTool('test', 'alpha', { value: 'x' });
        expect(result.content?.[0]?.text).toBe('echo:{"value":"x"}');

        await manager.disconnectAll();
    });

    test('lists every tool of the server in the direct loading mode', async () => {
        const server = await startTestMcpServer();
        servers.push(server);
        const manager = createManager(server.url);

        const tools = await manager.getAllToolsForDirectLoading();
        const names = tools.map(tool => tool.function.name).sort();
        expect(names).toEqual(['test__alpha', 'test__beta', 'test__fail', 'test__gamma', 'test__structured']);

        await manager.disconnectAll();
    });

    test('exposes the resources and the prompts of the server', async () => {
        const server = await startTestMcpServer();
        servers.push(server);
        const manager = createManager(server.url);

        const resources = await manager.listResources('test');
        expect(resources[0]?.uri).toBe('test://readme');
        expect(resources[0]?.serverName).toBe('test');

        const read = await manager.readResource('test', 'test://readme');
        expect((read as any).contents[0].text).toBe('the content of the resource');

        const prompts = await manager.listPrompts('test');
        expect(prompts[0]?.name).toBe('greet');
        expect(prompts[0]?.arguments?.[0]?.required).toBe(true);

        const prompt = await manager.getPrompt('test', 'greet', { who: 'Ada' });
        expect((prompt as any).messages[0].content.text).toBe('Hello Ada');

        await manager.disconnectAll();
    });

    test('reports the tool errors as exceptions', async () => {
        const server = await startTestMcpServer();
        servers.push(server);
        const manager = createManager(server.url);

        await expect(manager.callTool('test', 'fail', {})).rejects.toThrow(/failed on purpose/);

        await manager.disconnectAll();
    });

    test('returns the structured content of a tool', async () => {
        const server = await startTestMcpServer();
        servers.push(server);
        const manager = createManager(server.url);

        const result = await manager.callTool('test', 'structured', {});
        expect(result.structuredContent).toEqual({ total: 42 });

        await manager.disconnectAll();
    });

    test('rejects the arguments that do not match the input schema', async () => {
        const server = await startTestMcpServer();
        servers.push(server);
        const manager = createManager(server.url);

        // `value` must be a string
        await expect(manager.callTool('test', 'alpha', { value: 42 })).rejects.toThrow(/Invalid arguments/);

        await manager.disconnectAll();
    });

    test('reports an unknown tool', async () => {
        const server = await startTestMcpServer();
        servers.push(server);
        const manager = createManager(server.url);

        await expect(manager.callTool('test', 'does_not_exist', {})).rejects.toThrow(/not found/);

        await manager.disconnectAll();
    });
});

describe('integration: list_changed notification', () => {
    test('re-indexes the registry when the server announces a change', async () => {
        const server = await startTestMcpServer();
        servers.push(server);
        const manager = createManager(server.url);

        const before = await manager.getAllToolsForDirectLoading();
        expect(before.map(tool => tool.function.name)).not.toContain('test__delta');

        // The server adds a tool and announces the change
        await server.addTool({
            name: 'delta',
            description: 'Tool added at runtime',
            inputSchema: { type: 'object', properties: {} }
        });

        await waitFor(async () => {
            const current = await manager.getAllToolsForDirectLoading();
            return current.map(tool => tool.function.name).includes('test__delta');
        });

        const after = await manager.getAllToolsForDirectLoading();
        expect(after.map(tool => tool.function.name)).toContain('test__delta');

        await manager.disconnectAll();
    });
});

describe('integration: SEP-2243 header mirroring', () => {
    test('mirrors the annotated parameters into the Mcp-Param-* headers', async () => {
        const server = await startTestMcpServer({
            extraTools: [
                {
                    name: 'lookup',
                    description: 'Tool with a header annotation',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            region: {
                                type: 'string',
                                'x-mcp-header': 'region'
                            }
                        },
                        required: ['region']
                    }
                }
            ]
        });
        servers.push(server);
        const manager = createManager(server.url);

        await manager.callTool('test', 'lookup', { region: 'emea' });

        const call = server.requests.find(request => request.method === 'tools/call');
        expect(call).toBeDefined();
        expect(call!.headers['mcp-param-region']).toBe('emea');

        await manager.disconnectAll();
    });

    test('does not mirror the headers when the mode is "never"', async () => {
        const previous = process.env.MCP_HEADER_MODE;
        process.env.MCP_HEADER_MODE = 'never';
        try {
            const server = await startTestMcpServer({
                extraTools: [
                    {
                        name: 'lookup',
                        description: 'Tool with a header annotation',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                region: {
                                    type: 'string',
                                    'x-mcp-header': 'region'
                                }
                            },
                            required: ['region']
                        }
                    }
                ]
            });
            servers.push(server);
            const manager = createManager(server.url);

            await manager.callTool('test', 'lookup', { region: 'emea' });

            const call = server.requests.find(request => request.method === 'tools/call');
            expect(call!.headers['mcp-param-region']).toBeUndefined();

            await manager.disconnectAll();
        } finally {
            if (previous === undefined) delete process.env.MCP_HEADER_MODE;
            else process.env.MCP_HEADER_MODE = previous;
        }
    });

    test('sends the standard headers when the mode is "always"', async () => {
        const previous = process.env.MCP_HEADER_MODE;
        process.env.MCP_HEADER_MODE = 'always';
        try {
            const server = await startTestMcpServer();
            servers.push(server);
            const manager = createManager(server.url);

            await manager.callTool('test', 'alpha', {});

            const call = server.requests.find(request => request.method === 'tools/call');
            expect(call!.headers['mcp-method']).toBe('tools/call');
            expect(call!.headers['mcp-name']).toBe('alpha');

            await manager.disconnectAll();
        } finally {
            if (previous === undefined) delete process.env.MCP_HEADER_MODE;
            else process.env.MCP_HEADER_MODE = previous;
        }
    });
});
