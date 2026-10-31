import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ToolDispatcher } from './dispatch';
import { ConfirmationManager } from './confirm';
import { saveHistory, loadHistory, closeDatabase } from './db';

const tempDirs: string[] = [];

interface Harness {
    dispatcher: ToolDispatcher;
    calls: Array<{ serverName: string; toolName: string; args: any }>;
    sandboxCalls: Array<{ kind: string; payload: any }>;
    notifications: string[];
    mcp: any;
    sandbox: any;
}

/**
 * Build a dispatcher with mocked MCP and sandbox backends.
 * The answer of the user to a confirmation is simulated by the notify callback.
 */
const makeHarness = (options: {
    patterns?: string;
    answer?: string;
    timeoutSeconds?: number;
    tools?: Array<{ fullName: string; serverName: string; toolName: string }>;
    toolResult?: any;
    callToolError?: Error;
} = {}): Harness => {
    const calls: Harness['calls'] = [];
    const sandboxCalls: Harness['sandboxCalls'] = [];
    const notifications: string[] = [];

    const mcp = {
        searchTools: async () => [
            { serverName: 'fs', toolName: 'read_file', description: 'Reads a file' }
        ],
        getAvailableServers: async () => [
            { name: 'fs', description: 'Filesystem', connected: true, toolCount: 2, type: 'stdio' }
        ],
        getToolDetails: async () => ({
            name: 'read_file',
            description: 'Reads a file',
            inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
            outputSchema: { type: 'object', properties: { content: { type: 'string' } } }
        }),
        listResources: async () => [
            { serverName: 'fs', uri: 'file:///a.txt', name: 'a.txt', mimeType: 'text/plain' }
        ],
        readResource: async () => ({ contents: [{ uri: 'file:///a.txt', text: 'hello' }] }),
        listPrompts: async () => [
            { serverName: 'fs', name: 'greet', description: 'Greets', arguments: [{ name: 'who', required: true }] }
        ],
        getPrompt: async () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'hello there' } }] }),
        callTool: async (serverName: string, toolName: string, args: any) => {
            if (options.callToolError) throw options.callToolError;
            calls.push({ serverName, toolName, args });
            return options.toolResult ?? { content: [{ type: 'text', text: 'tool output' }] };
        },
        getToolsForSandbox: async () => options.tools ?? [
            { fullName: 'fs__read_file', serverName: 'fs', toolName: 'read_file' }
        ]
    };

    const sandbox = {
        execute: async (code: string) => {
            sandboxCalls.push({ kind: 'code', payload: code });
            return { output: 'sandbox output', toolCalls: 1 };
        },
        executeToolSequence: async (steps: any) => {
            sandboxCalls.push({ kind: 'sequence', payload: steps });
            return { output: 'sequence output', toolCalls: steps.length };
        }
    };

    const confirmationManager = new ConfirmationManager({
        patterns: options.patterns ?? '',
        timeoutSeconds: options.timeoutSeconds
    });
    const dispatcher = new ToolDispatcher(
        mcp as any,
        sandbox as any,
        confirmationManager,
        async (_to: string, text: string) => {
            notifications.push(text);
            confirmationManager.resolve('user1', options.answer ?? 'yes');
        },
        { sandboxTimeoutMs: 5000, maxToolResultLength: 8000 }
    );

    return { dispatcher, calls, sandboxCalls, notifications, mcp, sandbox };
};

beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-test-'));
    tempDirs.push(dir);
    process.env.SQLITE_DATABASE = join(dir, 'history.sqlite');
});

afterEach(() => {
    closeDatabase();
    delete process.env.SQLITE_DATABASE;
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) rmSync(dir, { recursive: true, force: true });
    }
});

const context = { user: 'user1', to: '555@c.us', isAdmin: false };
const adminContext = { user: 'admin1', to: '666@c.us', isAdmin: true };

describe('dispatch: discovery helpers', () => {
    test('search_tools lists the matching tools', async () => {
        const { dispatcher } = makeHarness();
        const result = await dispatcher.dispatch('search_tools', { query: 'read' }, context);
        expect(result).toContain('Search results:');
        expect(result).toContain('- fs__read_file: Reads a file');
    });

    test('search_tools reports that nothing was found', async () => {
        const { dispatcher, mcp } = makeHarness();
        mcp.searchTools = async () => [];
        const result = await dispatcher.dispatch('search_tools', { query: 'nothing' }, context);
        expect(result).toContain('No tools found matching the query.');
    });

    test('search_available_servers lists the servers', async () => {
        const { dispatcher } = makeHarness();
        const result = await dispatcher.dispatch('search_available_servers', {}, context);
        expect(result).toContain('- fs [connected]: Filesystem (2 tools, stdio)');
    });

    test('get_tool_details requires the server and the tool name', async () => {
        const { dispatcher } = makeHarness();
        const result = await dispatcher.dispatch('get_tool_details', { serverName: 'fs' }, context);
        expect(result).toBe('Error: serverName and toolName are required');
    });

    test('get_tool_details returns the schemas', async () => {
        const { dispatcher } = makeHarness();
        const result = await dispatcher.dispatch('get_tool_details', { serverName: 'fs', toolName: 'read_file' }, context);
        expect(result).toContain('Full Name: fs__read_file');
        expect(result).toContain('Input Schema:');
        expect(result).toContain('Output Schema:');
    });

    test('list_resources lists the resources', async () => {
        const { dispatcher } = makeHarness();
        const result = await dispatcher.dispatch('list_resources', {}, context);
        expect(result).toContain('- fs: file:///a.txt (a.txt) [text/plain]');
    });

    test('read_resource requires the server and the uri', async () => {
        const { dispatcher } = makeHarness();
        const result = await dispatcher.dispatch('read_resource', { serverName: 'fs' }, context);
        expect(result).toBe('Error: serverName and uri are required');
    });

    test('read_resource returns the content of the resource', async () => {
        const { dispatcher } = makeHarness();
        const result = await dispatcher.dispatch('read_resource', { serverName: 'fs', uri: 'file:///a.txt' }, context);
        expect(result).toContain('hello');
    });

    test('list_prompts lists the prompts with their arguments', async () => {
        const { dispatcher } = makeHarness();
        const result = await dispatcher.dispatch('list_prompts', {}, context);
        expect(result).toContain('- fs: greet - Greets (arguments: who (required))');
    });

    test('get_prompt returns the rendered messages', async () => {
        const { dispatcher } = makeHarness();
        const result = await dispatcher.dispatch('get_prompt', { serverName: 'fs', name: 'greet' }, context);
        expect(result).toContain('[user] hello there');
    });

    test('the errors of the helpers are reported to the model', async () => {
        const { dispatcher, mcp } = makeHarness();
        mcp.listResources = async () => { throw new Error('boom'); };
        const result = await dispatcher.dispatch('list_resources', {}, context);
        expect(result).toBe('Error listing resources: boom');
    });
});

describe('dispatch: call_tool', () => {
    test('calls the tool with the given arguments', async () => {
        const { dispatcher, calls } = makeHarness({ patterns: 'none' });
        const result = await dispatcher.dispatch('call_tool', {
            serverName: 'fs',
            toolName: 'read_file',
            args: { path: '/tmp/a' }
        }, context);
        expect(result).toBe('tool output');
        expect(calls).toEqual([{ serverName: 'fs', toolName: 'read_file', args: { path: '/tmp/a' } }]);
    });

    test('requires the server and the tool name', async () => {
        const { dispatcher } = makeHarness({ patterns: 'none' });
        const result = await dispatcher.dispatch('call_tool', { serverName: 'fs' }, context);
        expect(result).toBe('Error: serverName and toolName are required');
    });

    test('asks for confirmation and executes the tool after the approval', async () => {
        const { dispatcher, calls, notifications } = makeHarness({ patterns: '', answer: 'yes' });
        const result = await dispatcher.dispatch('call_tool', {
            serverName: 'fs',
            toolName: 'read_file',
            args: { path: '/tmp/a' }
        }, context);
        expect(notifications).toHaveLength(1);
        expect(notifications[0]).toContain('fs__read_file');
        expect(calls).toHaveLength(1);
        expect(result).toBe('tool output');
    });

    test('does not execute the tool when the user rejects the confirmation', async () => {
        const { dispatcher, calls } = makeHarness({ patterns: '', answer: 'no' });
        const result = await dispatcher.dispatch('call_tool', {
            serverName: 'fs',
            toolName: 'read_file',
            args: {}
        }, context);
        expect(calls).toHaveLength(0);
        expect(result).toContain('the user rejected the confirmation');
    });

    test('does not execute the tool when the confirmation expires', async () => {
        const { dispatcher, calls } = makeHarness({ patterns: '', answer: 'maybe', timeoutSeconds: 0.05 });
        const result = await dispatcher.dispatch('call_tool', {
            serverName: 'fs',
            toolName: 'read_file',
            args: {}
        }, context);
        expect(calls).toHaveLength(0);
        expect(result).toContain('the confirmation expired');
    });

    test('the confirmation question never shows the secrets', async () => {
        const { dispatcher, notifications } = makeHarness({ patterns: '' });
        await dispatcher.dispatch('call_tool', {
            serverName: 'fs',
            toolName: 'write_file',
            args: { api_key: 'super-secret', path: '/tmp/a' }
        }, context);
        expect(notifications[0]).not.toContain('super-secret');
        expect(notifications[0]).toContain('[redacted]');
    });

    test('the errors of the MCP server are reported to the model', async () => {
        const { dispatcher } = makeHarness({ patterns: 'none', callToolError: new Error('MCP tool error') });
        const result = await dispatcher.dispatch('call_tool', {
            serverName: 'fs',
            toolName: 'read_file',
            args: {}
        }, context);
        expect(result).toBe('Error calling tool: MCP tool error');
    });
});

describe('dispatch: direct MCP tool names', () => {
    test('calls the tool addressed by its full name', async () => {
        const { dispatcher, calls } = makeHarness({ patterns: 'none' });
        await dispatcher.dispatch('fs__read_file', { path: '/tmp/a' }, context);
        expect(calls).toEqual([{ serverName: 'fs', toolName: 'read_file', args: { path: '/tmp/a' } }]);
    });

    test('supports the names with dots', async () => {
        const { dispatcher, calls } = makeHarness({ patterns: 'none' });
        await dispatcher.dispatch('admin__tools.list', {}, context);
        expect(calls).toEqual([{ serverName: 'admin', toolName: 'tools.list', args: {} }]);
    });

    test('enforces the confirmation in the direct loading mode', async () => {
        const { dispatcher, calls } = makeHarness({ patterns: '', answer: 'no' });
        const result = await dispatcher.dispatch('fs__read_file', {}, context);
        expect(calls).toHaveLength(0);
        expect(result).toContain('NOT executed');
    });
});

describe('dispatch: sandbox', () => {
    test('execute_code runs the code in the sandbox', async () => {
        const { dispatcher, sandboxCalls } = makeHarness({ patterns: 'none' });
        const result = await dispatcher.dispatch('execute_code', { code: 'console.log(1)' }, context);
        expect(sandboxCalls[0]!.kind).toBe('code');
        expect(result).toContain('sandbox output');
    });

    test('execute_code requires a non empty code', async () => {
        const { dispatcher } = makeHarness({ patterns: 'none' });
        const result = await dispatcher.dispatch('execute_code', {}, context);
        expect(result).toBe('Error: code must be a non-empty string');
    });

    test('execute_code is confirmed when a protected tool is available', async () => {
        const { dispatcher, sandboxCalls, notifications } = makeHarness({ patterns: '', answer: 'no' });
        const result = await dispatcher.dispatch('execute_code', { code: 'console.log(1)' }, context);
        expect(notifications).toHaveLength(1);
        expect(sandboxCalls).toHaveLength(0);
        expect(result).toContain('NOT executed');
    });

    test('execute_code is not confirmed when no tool is protected', async () => {
        const { dispatcher, sandboxCalls, notifications } = makeHarness({
            patterns: 'delete*',
            tools: [{ fullName: 'fs__read_file', serverName: 'fs', toolName: 'read_file' }]
        });
        await dispatcher.dispatch('execute_code', { code: 'console.log(1)' }, context);
        expect(notifications).toHaveLength(0);
        expect(sandboxCalls).toHaveLength(1);
    });

    test('execute_tool_sequence rejects an empty list of steps', async () => {
        const { dispatcher } = makeHarness({ patterns: 'none' });
        const result = await dispatcher.dispatch('execute_tool_sequence', { steps: [], summary: 'x' }, context);
        expect(result).toBe('Error: steps must be a non-empty array');
    });

    test('execute_tool_sequence rejects too many steps', async () => {
        const { dispatcher } = makeHarness({ patterns: 'none' });
        const steps = Array.from({ length: 21 }, () => ({ serverName: 'fs', toolName: 'read_file' }));
        const result = await dispatcher.dispatch('execute_tool_sequence', { steps, summary: 'x' }, context);
        expect(result).toContain('too many steps (21)');
    });

    test('execute_tool_sequence marks the invalid steps instead of failing', async () => {
        const { dispatcher, sandboxCalls } = makeHarness({ patterns: 'none' });
        await dispatcher.dispatch('execute_tool_sequence', {
            steps: [{ serverName: 'fs' }, { serverName: 'fs', toolName: 'read_file' }],
            summary: 'x'
        }, context);
        const steps = sandboxCalls[0]!.payload as any[];
        expect(steps[0].valid).toBe(false);
        expect(steps[0].error).toBe('serverName and toolName are required');
        expect(steps[1].valid).toBe(true);
    });

    test('execute_tool_sequence is confirmed once for the protected steps', async () => {
        const { dispatcher, sandboxCalls, notifications } = makeHarness({ patterns: '', answer: 'yes' });
        await dispatcher.dispatch('execute_tool_sequence', {
            steps: [
                { serverName: 'fs', toolName: 'read_file' },
                { serverName: 'fs', toolName: 'write_file' }
            ],
            summary: 'x'
        }, context);
        expect(notifications).toHaveLength(1);
        expect(notifications[0]).toContain('fs__read_file');
        expect(notifications[0]).toContain('fs__write_file');
        expect(sandboxCalls).toHaveLength(1);
    });
});

describe('dispatch: host functions', () => {
    test('clean_current_chat clears the history of the user', async () => {
        saveHistory('user1', 'user', 'hello', '', '');
        const { dispatcher } = makeHarness();
        const result = await dispatcher.dispatch('clean_current_chat', {}, context);
        expect(result).toBe('Message history cleared successfully');
        expect(loadHistory('user1')).toHaveLength(0);
    });

    test('clean_current_chat reports an empty history', async () => {
        const { dispatcher } = makeHarness();
        const result = await dispatcher.dispatch('clean_current_chat', {}, context);
        expect(result).toBe('Error clearing message history');
    });

    test('clean_chat is only available for the administrators', async () => {
        saveHistory('user2', 'user', 'hello', '', '');
        const { dispatcher } = makeHarness();
        const result = await dispatcher.dispatch('clean_chat', { user: 'user2' }, context);
        expect(result).toBe('Unknown tool: clean_chat');
        expect(loadHistory('user2')).toHaveLength(1);
    });

    test('clean_chat clears the history of another user', async () => {
        saveHistory('user2', 'user', 'hello', '', '');
        const { dispatcher } = makeHarness();
        const result = await dispatcher.dispatch('clean_chat', { user: 'user2' }, adminContext);
        expect(result).toBe('Message history for user2 cleared successfully');
        expect(loadHistory('user2')).toHaveLength(0);
    });

    test('clean_all_chats clears every history', async () => {
        saveHistory('user1', 'user', 'hello', '', '');
        saveHistory('user2', 'user', 'hello', '', '');
        const { dispatcher } = makeHarness();
        const result = await dispatcher.dispatch('clean_all_chats', {}, adminContext);
        expect(result).toBe('All message history cleared successfully');
        expect(loadHistory('user1')).toHaveLength(0);
        expect(loadHistory('user2')).toHaveLength(0);
    });

    test('an unknown tool is reported to the model', async () => {
        const { dispatcher } = makeHarness();
        const result = await dispatcher.dispatch('does_not_exist', {}, context);
        expect(result).toBe('Unknown tool: does_not_exist');
    });
});
