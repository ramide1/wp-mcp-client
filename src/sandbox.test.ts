import { describe, expect, test } from 'bun:test';
import { SandboxRunner } from './sandbox';

// Every test spawns a real Bun subprocess: the default 5s timeout of the test
// runner is not enough under load, so an explicit budget is used.
const SANDBOX_TEST_TIMEOUT = 60_000;

const fakeManager = {
    callTool: async (_server: string, tool: string, args: any) => ({
        content: [{ type: 'text', text: `OK ${tool} ${JSON.stringify(args)}` }]
    })
} as any;

const tools = [
    { fullName: 'fs__read', serverName: 'fs', toolName: 'read' },
    { fullName: 'fs__write', serverName: 'fs', toolName: 'write' }
];

const run = async (code: string) => {
    const runner = new SandboxRunner(fakeManager);
    return await runner.execute(code, tools, 20000);
};

describe('SandboxRunner.execute', () => {
    test('runs model code and returns its console output', async () => {
        const result = await run('console.log("hello from the sandbox")');
        expect(result.error).toBeUndefined();
        expect(result.output).toContain('hello from the sandbox');
    }, SANDBOX_TEST_TIMEOUT);

    test('calls MCP tools through the stubs', async () => {
        const result = await run('const r = await tools["fs__read"]({ p: 1 }); console.log(JSON.stringify(r));');
        expect(result.error).toBeUndefined();
        expect(result.toolCalls).toBe(1);
        expect(result.output).toContain('OK read');
    }, SANDBOX_TEST_TIMEOUT);

    test('supports concurrent tool calls', async () => {
        const result = await run('await Promise.all([tools["fs__read"]({}), tools["fs__write"]({})]); console.log("done");');
        expect(result.error).toBeUndefined();
        expect(result.toolCalls).toBe(2);
        expect(result.output).toContain('done');
    }, SANDBOX_TEST_TIMEOUT);

    test('supports top level import statements', async () => {
        const result = await run('import path from "node:path"; console.log(typeof path.join);');
        expect(result.error).toBeUndefined();
        expect(result.output).toContain('function');
    }, SANDBOX_TEST_TIMEOUT);

    test('does not expose the host environment', async () => {
        process.env.SANDBOX_TEST_SECRET = 'super-secret';
        try {
            const result = await run('console.log(process.env.SANDBOX_TEST_SECRET ?? "hidden");');
            expect(result.output).toContain('hidden');
        } finally {
            delete process.env.SANDBOX_TEST_SECRET;
        }
    }, SANDBOX_TEST_TIMEOUT);

    test('blocks direct network access', async () => {
        const result = await run('try { await fetch("http://example.com"); console.log("NOT BLOCKED"); } catch (e) { console.log("blocked"); }');
        expect(result.output).toContain('blocked');
        expect(result.output).not.toContain('NOT BLOCKED');
    }, SANDBOX_TEST_TIMEOUT);

    test('blocks the node http builtin', async () => {
        const result = await run('import http from "node:http"; try { http.request("http://example.com"); console.log("NOT BLOCKED"); } catch (e) { console.log("blocked"); }');
        expect(result.output).toContain('blocked');
        expect(result.output).not.toContain('NOT BLOCKED');
    }, SANDBOX_TEST_TIMEOUT);

    test('blocks direct filesystem access', async () => {
        const result = await run('import { readFileSync } from "node:fs"; try { readFileSync("/etc/hostname"); console.log("NOT BLOCKED"); } catch (e) { console.log("blocked"); }');
        expect(result.output).toContain('blocked');
        expect(result.output).not.toContain('NOT BLOCKED');
    }, SANDBOX_TEST_TIMEOUT);

    test('reports syntax errors instead of failing silently', async () => {
        const result = await run('const = ;');
        expect(result.error).toBeTruthy();
    }, SANDBOX_TEST_TIMEOUT);
});

describe('SandboxRunner.executeToolSequence', () => {
    test('executes the steps and reports the outcome', async () => {
        const runner = new SandboxRunner(fakeManager);
        const steps = [
            { index: 0, serverName: 'fs', toolName: 'read', args: { p: 1 }, valid: true },
            { index: 1, serverName: 'fs', toolName: 'write', args: { p: 2 }, saveAs: 'w', valid: true }
        ];
        const result = await runner.executeToolSequence(steps as any, tools, 20000, 'summarize');
        expect(result.error).toBeUndefined();
        expect(result.toolCalls).toBe(2);
        expect(result.output).toContain('2 succeeded');
        expect(result.output).toContain('fs__read');
    }, SANDBOX_TEST_TIMEOUT);

    test('reports invalid steps without failing the whole sequence', async () => {
        const runner = new SandboxRunner(fakeManager);
        const steps = [
            { index: 0, serverName: '', toolName: '', args: {}, valid: false, error: 'serverName and toolName are required' }
        ];
        const result = await runner.executeToolSequence(steps as any, tools, 20000, 'summarize');
        expect(result.output).toContain('serverName and toolName are required');
    }, SANDBOX_TEST_TIMEOUT);
});
