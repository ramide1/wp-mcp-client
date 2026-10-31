import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MCPClientManager, ToolNotFoundError, ToolValidationError, isValidToolName, isValidServerName } from './mcp';

const tempDirs: string[] = [];

afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) rmSync(dir, { recursive: true, force: true });
    }
});

/**
 * Build a manager with a single enabled server and a fake connected client.
 */
const managerWithFakeServer = (tools: Array<Record<string, unknown>>): { manager: MCPClientManager; listTools: () => number } => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'mcp-servers.json');
    writeFileSync(configPath, JSON.stringify({
        servers: [{ name: 'demo', type: 'stdio', command: 'true', enabled: true }]
    }), 'utf8');

    const manager = new MCPClientManager(configPath);
    let calls = 0;
    const fakeClient = {
        listTools: async () => {
            calls++;
            return { tools };
        },
        callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
        close: async () => { }
    };
    (manager as any).clients.set('demo', fakeClient);
    return { manager, listTools: () => calls };
};

describe('tool names', () => {
    test('builds and parses names with the double underscore delimiter', () => {
        const full = MCPClientManager.getFullToolName('filesystem', 'read_file');
        expect(full).toBe('filesystem__read_file');
        expect(MCPClientManager.parseToolName(full)).toEqual({ serverName: 'filesystem', toolName: 'read_file' });
    });

    test('parses names whose tool part contains underscores', () => {
        expect(MCPClientManager.parseToolName('fs__read__all')).toEqual({ serverName: 'fs', toolName: 'read__all' });
    });

    test('rejects malformed names', () => {
        expect(MCPClientManager.parseToolName('no-delimiter')).toBeNull();
        expect(MCPClientManager.parseToolName('__missing-server')).toBeNull();
        expect(MCPClientManager.parseToolName('')).toBeNull();
    });

    test('accepts the characters allowed by the spec', () => {
        expect(isValidToolName('valid_name-1')).toBe(true);
        expect(isValidToolName('admin.tools.list')).toBe(true);
        expect(isValidToolName('a'.repeat(128))).toBe(true);
    });

    test('rejects names with characters outside the allowed set', () => {
        expect(isValidToolName('invalid name')).toBe(false);
        expect(isValidToolName('invalid$name')).toBe(false);
        expect(isValidToolName('')).toBe(false);
        expect(isValidToolName('a'.repeat(129))).toBe(false);
    });

    test('parses names whose tool part contains dots', () => {
        expect(MCPClientManager.parseToolName('admin__tools.list')).toEqual({ serverName: 'admin', toolName: 'tools.list' });
    });

    test('server names must not contain the delimiter', () => {
        expect(isValidServerName('filesystem')).toBe(true);
        expect(isValidServerName('my.server')).toBe(true);
        expect(isValidServerName('my__server')).toBe(false);
        expect(isValidServerName('my server')).toBe(false);
    });
});

describe('listAllTools', () => {
    test('follows the pagination cursor until it is exhausted', async () => {
        const manager = new MCPClientManager('/tmp/does-not-exist.json');
        const pages: Record<string, any> = {
            '': { tools: [{ name: 'a' }], nextCursor: 'p2' },
            p2: { tools: [{ name: 'b' }], nextCursor: 'p3' },
            p3: { tools: [{ name: 'c' }] }
        };
        const client: any = {
            listTools: async (params: any) => pages[params?.cursor ?? '']
        };

        const result = await manager.listAllTools(client);
        expect(result.tools.map((t: any) => t.name)).toEqual(['a', 'b', 'c']);
    });

    test('reads ttlMs from the result and from _meta', async () => {
        const manager = new MCPClientManager('/tmp/does-not-exist.json');
        const client: any = {
            listTools: async () => ({ tools: [{ name: 'a' }], ttlMs: 1234 })
        };
        expect((await manager.listAllTools(client)).serverTtlMs).toBe(1234);

        const legacyClient: any = {
            listTools: async () => ({ tools: [{ name: 'a' }], _meta: { ttlMs: 4321 } })
        };
        expect((await manager.listAllTools(legacyClient)).serverTtlMs).toBe(4321);
    });
});

describe('callTool', () => {
    test('rejects an unknown tool with a ToolNotFoundError', async () => {
        const { manager } = managerWithFakeServer([{ name: 'alpha' }]);
        await expect(manager.callTool('demo', 'missing', {})).rejects.toBeInstanceOf(ToolNotFoundError);
    });

    test('rejects invalid arguments with a ToolValidationError', async () => {
        const { manager } = managerWithFakeServer([{
            name: 'echo',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
        }]);
        await expect(manager.callTool('demo', 'echo', {})).rejects.toBeInstanceOf(ToolValidationError);
    });
});

describe('getAllToolsForDirectLoading', () => {
    test('lists the tools when the cache is empty', async () => {
        const { manager, listTools } = managerWithFakeServer([{ name: 'alpha' }, { name: 'beta' }]);
        const tools = await manager.getAllToolsForDirectLoading();
        expect(tools.map(t => t.function.name)).toEqual(['demo__alpha', 'demo__beta']);
        expect(listTools()).toBe(1);
    });

    test('rebuilds the list when the cached definitions expire', async () => {
        const { manager, listTools } = managerWithFakeServer([{ name: 'alpha' }]);
        await manager.getAllToolsForDirectLoading();
        expect(listTools()).toBe(1);

        // Age every cache entry beyond the default TTL and force the eviction
        const cache = (manager as any).toolCache as Map<string, { timestamp: number }>;
        for (const entry of cache.values()) entry.timestamp = Date.now() - 60 * 60 * 1000;
        (manager as any).evictExpiredCache();

        const tools = await manager.getAllToolsForDirectLoading();
        expect(tools.map(t => t.function.name)).toEqual(['demo__alpha']);
        expect(listTools()).toBe(2);
    });
});
