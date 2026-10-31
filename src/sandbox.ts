import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { toolNameDelimiter } from './mcp';
import { timeoutFromEnv } from './env';
import type { MCPClientManager } from './mcp';
import type { SandboxResult, SandboxToolStub, SandboxStep } from './interface';

/**
 * SandboxRunner executes model-generated code in an isolated Bun subprocess.
 *
 * Security model (per MCP client best practices):
 * - No direct network access: fetch/XHR/WebSocket/EventSource and the node:net/http/https/tls/dgram
 *   primitives are blocked. All external communication must go through MCP tool stubs.
 * - No credential exposure: the child is spawned with a scrubbed environment, so API keys and
 *   other secrets of the host process are not visible to the generated code.
 * - No direct filesystem/process access: node:fs, node:child_process and the equivalent Bun APIs
 *   are blocked, and the child runs in an isolated temporary working directory.
 * - Per-call authorization: tool whitelist via SANDBOX_ALLOWED_TOOLS.
 * - Resource limits: configurable timeout, memory and max tool calls.
 * - Output filtering: only console output returns to the model.
 *
 * Configuration (via environment variables):
 * - SANDBOX_TIMEOUT: Max execution time in seconds (default: 30)
 * - SANDBOX_MEMORY_MB: Max memory in MB (default: 256)
 * - SANDBOX_MAX_TOOL_CALLS: Max tool calls per execution (default: 50)
 * - SANDBOX_MAX_OUTPUT_LENGTH: Max output characters (default: 10000)
 * - SANDBOX_NETWORK_ACCESS: Allow network access in sandbox (default: false)
 * - SANDBOX_ALLOWED_TOOLS: Comma-separated whitelist of tool names (empty = all allowed)
 * - SANDBOX_STEP_TIMEOUT: Timeout in seconds for each step of execute_tool_sequence (default: 30)
 *
 * Communication protocol (JSON lines over stdin/stdout):
 * - Child -> Parent: {"type":"call","id":"...","tool":"server__tool","args":{...}}
 * - Parent -> Child: {"type":"result","id":"...","result":...} or {"type":"result","id":"...","error":"..."}
 * - Child -> Parent: {"type":"done","output":"..."}
 */
export class SandboxRunner {
  private mcpManager: MCPClientManager;
  private readonly memoryMB: number;
  private readonly maxToolCalls: number;
  private readonly maxOutputLength: number;
  private readonly networkAccess: boolean;
  private readonly allowedTools: Set<string>;
  private readonly stepTimeoutMs: number;

  constructor(mcpManager: MCPClientManager) {
    this.mcpManager = mcpManager;
    this.memoryMB = parseInt(process.env.SANDBOX_MEMORY_MB ?? '256');
    this.maxToolCalls = parseInt(process.env.SANDBOX_MAX_TOOL_CALLS ?? '50');
    this.maxOutputLength = parseInt(process.env.SANDBOX_MAX_OUTPUT_LENGTH ?? '10000');
    this.networkAccess = process.env.SANDBOX_NETWORK_ACCESS === 'true';
    this.stepTimeoutMs = timeoutFromEnv('SANDBOX_STEP_TIMEOUT', 30);
    // Parse comma-separated whitelist; empty = all tools allowed
    const rawAllowed = process.env.SANDBOX_ALLOWED_TOOLS ?? '';
    this.allowedTools = new Set(
      rawAllowed.split(',').map(s => s.trim()).filter(s => s.length > 0)
    );
  }

  /**
   * Check if a tool is allowed by the whitelist.
   * Empty whitelist means all tools are allowed (backward compatible).
   */
  private isToolAllowed(fullName: string): boolean {
    if (this.allowedTools.size === 0) return true;
    return this.allowedTools.has(fullName);
  }

  /**
   * Environment handed to the sandbox child process.
   * Only a minimal allowlist is forwarded so that credentials of the host process
   * (API keys, tokens) are never exposed to model-generated code.
   */
  private sandboxEnv(workDir: string): Record<string, string> {
    const env: Record<string, string> = {};
    const forwarded = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT', 'ComSpec', 'PATHEXT'];
    for (const key of forwarded) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    // Isolate HOME/TMPDIR inside the sandbox working directory
    env.HOME = workDir;
    env.TMPDIR = workDir;
    env.TEMP = workDir;
    env.TMP = workDir;
    return env;
  }

  /**
   * Execute model-generated code in a sandboxed Bun subprocess with access to MCP tools.
   * @param code The JavaScript/TypeScript code to execute
   * @param tools Available tool stubs for the sandbox
   * @param timeoutMs Maximum execution time in milliseconds
   * @returns Sandbox result with output and optional error
   */
  async execute(code: string, tools: SandboxToolStub[], timeoutMs = 30_000): Promise<SandboxResult> {
    if (tools.length === 0) {
      return { output: '', error: 'No MCP tools available for sandbox execution', toolCalls: 0 };
    }

    const workDir = mkdtempSync(join(tmpdir(), 'wp-mcp-sandbox-'));
    const runnerPath = join(workDir, 'runner.ts');
    const modelPath = join(workDir, 'model.ts');

    try {
      // The model code lives in its own module so that top level `import` statements
      // are valid and so that the security guards are installed before it is evaluated.
      writeFileSync(modelPath, code, 'utf8');
      writeFileSync(runnerPath, this.buildRunnerScript(tools, './model.ts'), 'utf8');

      const proc = Bun.spawn(['bun', 'run', `--max-old-space-size=${this.memoryMB}`, runnerPath], {
        cwd: workDir,
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'pipe',
        env: this.sandboxEnv(workDir),
      });
      return await this.runSubprocess(proc, tools, timeoutMs);
    } finally {
      try { rmSync(workDir, { recursive: true, force: true }); } catch { }
    }
  }

  /**
   * Execute a sequence of MCP tool calls in a sandboxed subprocess.
   * Tool stubs are injected via stdin/stdout JSON lines protocol.
   * Intermediate results stay in the subprocess — only the summary returns to the model.
   * @param steps Validated steps to execute (with dependency graph via saveAs/useResultFrom)
   * @param tools Available tool stubs for the sandbox
   * @param timeoutMs Maximum execution time in milliseconds
   * @param summaryPrompt A prompt describing what summary to produce
   * @returns Sandbox result with summary output and optional error
   */
  async executeToolSequence(
    steps: SandboxStep[],
    tools: SandboxToolStub[],
    timeoutMs: number,
    summaryPrompt: string
  ): Promise<SandboxResult> {
    if (tools.length === 0) {
      return { output: '', error: 'No MCP tools available for sandbox execution', toolCalls: 0 };
    }

    const workDir = mkdtempSync(join(tmpdir(), 'wp-mcp-sandbox-'));
    const runnerPath = join(workDir, 'runner.ts');

    try {
      writeFileSync(runnerPath, this.buildRunnerScript(tools, null, this.buildSequenceBody(steps, summaryPrompt)), 'utf8');

      const proc = Bun.spawn(['bun', 'run', `--max-old-space-size=${this.memoryMB}`, runnerPath], {
        cwd: workDir,
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'pipe',
        env: this.sandboxEnv(workDir),
      });
      return await this.runSubprocess(proc, tools, timeoutMs);
    } finally {
      try { rmSync(workDir, { recursive: true, force: true }); } catch { }
    }
  }

  private safeStdinWrite(proc: ReturnType<typeof Bun.spawn>, data: Uint8Array): void {
    try {
      (proc.stdin as any).write(data);
    } catch {
      // Child process may have exited; ignore write errors
    }
  }

  private async runSubprocess(
    proc: ReturnType<typeof Bun.spawn>,
    tools: SandboxToolStub[],
    timeoutMs: number
  ): Promise<SandboxResult> {
    const decoder = new TextDecoder();
    let error: string | undefined;
    let toolCallCount = 0;
    let doneOutput: string | undefined;

    const stdout = proc.stdout as ReadableStream<Uint8Array>;
    const stderrStream = proc.stderr as ReadableStream<Uint8Array>;

    const stdoutDone = (async () => {
      const reader = stdout.getReader();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'call') {
              toolCallCount++;
              // Enforce max tool calls limit to prevent runaway scripts
              if (toolCallCount > this.maxToolCalls) {
                this.safeStdinWrite(proc, new TextEncoder().encode(JSON.stringify({ type: 'result', id: msg.id, error: `Tool call limit exceeded (${this.maxToolCalls}). Stopping execution.` }) + '\n'));
                continue;
              }
              const toolDef = tools.find(t => t.fullName === msg.tool);
              if (toolDef) {
                // Per-call authorization: check tool whitelist
                if (!this.isToolAllowed(msg.tool)) {
                  this.safeStdinWrite(proc, new TextEncoder().encode(JSON.stringify({ type: 'result', id: msg.id, error: `Tool not allowed by sandbox policy: ${msg.tool}. Add it to SANDBOX_ALLOWED_TOOLS to permit.` }) + '\n'));
                  continue;
                }
                try {
                  const result = await this.mcpManager.callTool(toolDef.serverName, toolDef.toolName, msg.args || {});
                  this.safeStdinWrite(proc, new TextEncoder().encode(JSON.stringify({ type: 'result', id: msg.id, result }) + '\n'));
                } catch (err) {
                  this.safeStdinWrite(proc, new TextEncoder().encode(JSON.stringify({ type: 'result', id: msg.id, error: String(err) }) + '\n'));
                }
              } else {
                this.safeStdinWrite(proc, new TextEncoder().encode(JSON.stringify({ type: 'result', id: msg.id, error: `Tool not found: ${msg.tool}` }) + '\n'));
              }
            } else if (msg.type === 'done') {
              doneOutput = msg.output || '';
            }
          } catch { }
        }
      }
    })();

    let stderrText = '';
    const stderrDone = (async () => {
      const reader = stderrStream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrText += decoder.decode(value, { stream: true });
      }
    })();

    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        proc.kill();
        reject(new Error(`Sandbox timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
    });

    try {
      // Wait for BOTH stdout and stderr to finish, or timeout
      await Promise.race([Promise.all([stdoutDone, stderrDone]), timeout]);
    } catch (err) {
      if (err instanceof Error && err.message.includes('timed out')) {
        return { output: '', error: err.message, toolCalls: toolCallCount };
      }
      throw err;
    } finally {
      // The timeout timer must not outlive the subprocess it was guarding.
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    const exitCode = await proc.exited;

    if (timedOut) {
      return { output: '', error: `Sandbox timed out after ${timeoutMs / 1000}s`, toolCalls: toolCallCount };
    }

    if (exitCode !== 0) {
      error = stderrText.trim() || `Sandbox exited with code ${exitCode}`;
      return { output: '', error, toolCalls: toolCallCount };
    }

    if (doneOutput === undefined) {
      // The child finished without reporting completion (e.g. it called process.exit itself)
      error = stderrText.trim() || 'Sandbox exited without reporting a result';
      return { output: '', error, toolCalls: toolCallCount };
    }

    let output = doneOutput;
    if (stderrText.trim()) {
      output = output ? `${output}\n[STDERR] ${stderrText.trim()}` : `[STDERR] ${stderrText.trim()}`;
    }
    if (output.length > this.maxOutputLength) {
      output = output.substring(0, this.maxOutputLength) + '\n... [output truncated]';
    }
    return { output, error, toolCalls: toolCallCount };
  }
  /**
   * Build the runner script executed inside the sandbox.
   * @param tools Tool stubs exposed to the sandboxed code
   * @param modelImport Relative path of the module with the model generated code (null for sequences)
   * @param body Inline body executed instead of a model import (used by execute_tool_sequence)
   */
  private buildRunnerScript(tools: SandboxToolStub[], modelImport: string | null, body?: string): string {
    const payload = modelImport
      ? `await import(${JSON.stringify(modelImport)});`
      : (body ?? '');

    return `// MCP Sandbox runner (generated)
${this.buildGuardCode()}
${this.buildProtocolCode(tools)}

const __finish = (code) => {
  // Flush before exiting: a pending pipe write is dropped when process.exit() runs.
  setTimeout(() => process.exit(code), 1000);
};
try {
${payload}
  const __done = JSON.stringify({ type: 'done', output: __output.join('\\n') }) + '\\n';
  __protocolWrite(__done, () => process.exit(0));
  __finish(0);
} catch (e) {
  const __message = (e && e.stack) || (e && e.message) || String(e);
  try { process.stderr.write(__message, () => process.exit(1)); } catch { process.exit(1); }
  __finish(1);
}
`;
  }

  /**
   * Security guards installed before any model generated code is evaluated.
   * Blocks direct network access, filesystem access and process spawning.
   */
  private buildGuardCode(): string {
    const networkGuards = this.networkAccess ? '' : `
  // --- network isolation (SANDBOX_NETWORK_ACCESS=false) ---
  __safeAssign(net, 'connect', __deny('net.connect'));
  __safeAssign(net, 'createConnection', __deny('net.createConnection'));
  if (net.Socket && net.Socket.prototype) __safeAssign(net.Socket.prototype, 'connect', __deny('socket.connect'));
  __safeAssign(http, 'request', __deny('http.request'));
  __safeAssign(http, 'get', __deny('http.get'));
  __safeAssign(https, 'request', __deny('https.request'));
  __safeAssign(https, 'get', __deny('https.get'));
  __safeAssign(tls, 'connect', __deny('tls.connect'));
  __safeAssign(dgram, 'createSocket', __deny('dgram.createSocket'));
  __safeAssign(dns, 'lookup', __deny('dns.lookup'));
  __safeAssign(dns, 'resolve', __deny('dns.resolve'));
  __safeAssign(dns.promises, 'lookup', __deny('dns.promises.lookup'));
  __safeAssign(BunApi, 'connect', __deny('Bun.connect'));
  __safeAssign(BunApi, 'listen', __deny('Bun.listen'));
  __safeAssign(BunApi, 'serve', __deny('Bun.serve'));
  const __blockNetwork = () => { throw new Error('Direct network access is blocked in sandbox. Use MCP tools instead.'); };
  __safeAssign(globalThis, 'fetch', __blockNetwork);
  __safeAssign(globalThis, 'XMLHttpRequest', class { open() { __blockNetwork(); } send() { __blockNetwork(); } });
  __safeAssign(globalThis, 'WebSocket', class { constructor() { __blockNetwork(); } });
  __safeAssign(globalThis, 'EventSource', class { constructor() { __blockNetwork(); } });
`;

    return `// --- sandbox guards ---
const __deny = (what) => () => { throw new Error(what + ' is blocked inside the MCP sandbox. Use MCP tools instead.'); };
const __safeAssign = (target, key, value) => { try { target[key] = value; } catch { } };
const BunApi = globalThis.Bun;
try {
  const net = require('node:net');
  const http = require('node:http');
  const https = require('node:https');
  const tls = require('node:tls');
  const dgram = require('node:dgram');
  const dns = require('node:dns');
${networkGuards}
} catch { }
try {
  // --- filesystem isolation ---
  const fs = require('node:fs');
  for (const method of ['readFileSync','writeFileSync','appendFileSync','readFile','writeFile','appendFile','createReadStream','createWriteStream','unlinkSync','rmSync','rmdirSync','mkdirSync','readdirSync','readdir','statSync','lstatSync','existsSync','copyFileSync','renameSync','openSync','opendirSync','watch','watchFile']) {
    if (method in fs) __safeAssign(fs, method, __deny('fs.' + method));
  }
  const fsp = require('node:fs/promises');
  for (const method of ['readFile','writeFile','appendFile','mkdir','rm','rmdir','readdir','stat','lstat','access','open','copyFile','rename','realpath','watch']) {
    if (method in fsp) __safeAssign(fsp, method, __deny('fs.' + method));
  }
} catch { }
try {
  // --- process isolation ---
  const cp = require('node:child_process');
  for (const method of ['exec','execSync','spawn','spawnSync','execFile','execFileSync','fork']) {
    if (method in cp) __safeAssign(cp, method, __deny('child_process.' + method));
  }
  const wt = require('node:worker_threads');
  __safeAssign(wt, 'Worker', __deny('worker_threads.Worker'));
} catch { }
try {
  __safeAssign(BunApi, 'file', __deny('Bun.file'));
  __safeAssign(BunApi, 'write', __deny('Bun.write'));
  __safeAssign(BunApi, 'spawn', __deny('Bun.spawn'));
  __safeAssign(BunApi, 'spawnSync', __deny('Bun.spawnSync'));
  __safeAssign(BunApi, '$', __deny('Bun.$'));
} catch { }
`;
  }

  /**
   * JSON lines protocol between the sandbox child and the host process.
   * A single reader is shared by all tool stubs so concurrent calls are supported.
   */
  private buildProtocolCode(tools: SandboxToolStub[]): string {
    const toolEntries = tools.map(tool => {
      return `  ${JSON.stringify(tool.fullName)}: (args = {}) => __mcpCall(${JSON.stringify(tool.fullName)}, args),`;
    }).join('\n');

    const takenAliases = new Set<string>();
    const aliases = tools.map(tool => {
      const alias = this.aliasFor(tool.fullName, takenAliases);
      return `  if (!(${JSON.stringify(alias)} in globalThis)) globalThis[${JSON.stringify(alias)}] = __tools[${JSON.stringify(tool.fullName)}];`;
    }).join('\n');

    return `// --- output capture (the protocol owns the real stdout) ---
const __protocolWrite = process.stdout.write.bind(process.stdout);
const __output = [];
const __toText = (args) => args.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
console.log = (...args) => { __output.push(__toText(args)); };
console.error = (...args) => { __output.push('[ERROR] ' + __toText(args)); };
process.stdout.write = (chunk) => {
  try { __output.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)); } catch { }
  return true;
};

// --- MCP tool stubs (stdin/stdout JSON lines) ---
const __pending = new Map();
const __decoder = new TextDecoder();
let __buffer = '';
(async () => {
  const reader = Bun.stdin.stream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    __buffer += __decoder.decode(value, { stream: true });
    const lines = __buffer.split('\\n');
    __buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const resolve = __pending.get(msg.id);
        if (!resolve) continue;
        __pending.delete(msg.id);
        if (msg.error) resolve({ error: msg.error }); else resolve({ result: msg.result });
      } catch { }
    }
  }
})();

async function __mcpCall(tool, args) {
  const id = String(Date.now()) + Math.random().toString(36).slice(2);
  const response = new Promise((resolve) => __pending.set(id, resolve));
  __protocolWrite(JSON.stringify({ type: 'call', id, tool, args }) + '\\n');
  const settled = await response;
  if (settled.error) throw new Error(settled.error);
  return settled.result;
}

const __tools = {
${toolEntries}
};
globalThis.tools = __tools;
globalThis.mcp = __tools;
${aliases}
`;
  }

  /**
   * Alias exposed as a global function inside the sandbox.
   * It must be a valid JavaScript identifier and unique among the stubs.
   */
  private aliasFor(fullName: string, taken: Set<string>): string {
    const base = fullName.replace(/[^a-zA-Z0-9_]/g, '_');
    const alias = /^[0-9]/.test(base) ? '_' + base : base;
    let candidate = alias;
    let suffix = 2;
    while (taken.has(candidate)) {
      candidate = `${alias}_${suffix++}`;
    }
    taken.add(candidate);
    return candidate;
  }

  /**
   * Body executed by execute_tool_sequence: runs the validated steps, chaining results
   * through saveAs/useResultFrom and retrying transient failures.
   */
  private buildSequenceBody(steps: SandboxStep[], summaryPrompt: string): string {
    const stepsJson = JSON.stringify(steps.map(s => ({
      index: s.index,
      serverName: s.serverName,
      toolName: s.toolName,
      args: s.args || {},
      saveAs: s.saveAs || null,
      useResultFrom: s.useResultFrom || null,
      valid: s.valid,
      error: s.error || null,
    })));

    return `
const steps = ${stepsJson};
const summaryPrompt = ${JSON.stringify(summaryPrompt)};
const TOOL_NAME_DELIMITER = ${JSON.stringify(toolNameDelimiter)};
const STEP_TIMEOUT_MS = ${this.stepTimeoutMs};

const results = {};
const outputs = [];
let successCount = 0;
let errorCount = 0;

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const RETRYABLE_PATTERN = /rate.limit|timeout|ECONNRESET|ECONNABORTED|ETIMEDOUT|ECONNREFUSED|502|503|504/i;

function isRetryableError(msg) {
  return RETRYABLE_PATTERN.test(msg || '');
}

async function executeStep(step) {
  if (!step.valid) {
    outputs.push(\`Step \${step.index + 1}: Error - \${step.error}\`);
    errorCount++;
    return;
  }

  let args = step.args;
  if (step.useResultFrom && results[step.useResultFrom]) {
    try { args = JSON.parse(results[step.useResultFrom]); } catch { args = results[step.useResultFrom]; }
  }

  const fullName = step.serverName + TOOL_NAME_DELIMITER + step.toolName;
  const toolFn = __tools[fullName];
  if (!toolFn) {
    outputs.push(\`Step \${step.index + 1} (\${fullName}): Error - Tool not found\`);
    errorCount++;
    return;
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await Promise.race([
        toolFn(args),
        new Promise((_, rej) => setTimeout(() => rej(new Error(\`Step timeout after \${STEP_TIMEOUT_MS / 1000}s\`)), STEP_TIMEOUT_MS))
      ]);

      let text = '';
      if (result && result.content && Array.isArray(result.content)) {
        for (const c of result.content) {
          if (c.type === 'text') text += c.text;
        }
      }
      if (result && result.structuredContent !== undefined && result.structuredContent !== null) {
        text = text || JSON.stringify(result.structuredContent);
      }
      if (!text) text = JSON.stringify(result);

      if (step.saveAs) results[step.saveAs] = text;

      const truncated = text.length > 300 ? text.substring(0, 300) + '...' : text;
      const retryMsg = attempt > 0 ? \` (succeeded after \${attempt} retries)\` : '';
      outputs.push(\`Step \${step.index + 1} (\${fullName}): \${truncated}\${retryMsg}\`);
      successCount++;
      return;
    } catch (e) {
      const errMsg = (e && e.message) || String(e);
      if (isRetryableError(errMsg) && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        outputs.push(\`Step \${step.index + 1} (\${fullName}): Retry \${attempt + 1}/\${MAX_RETRIES} after \${delay}ms (\${errMsg})\`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      outputs.push(\`Step \${step.index + 1} (\${fullName}): Error - \${errMsg}\`);
      errorCount++;
      return;
    }
  }
}

// Group steps into waves by dependencies
const remaining = [...steps];
while (remaining.length > 0) {
  const ready = remaining.filter(s => {
    if (!s.valid) return true;
    if (!s.useResultFrom) return true;
    return s.useResultFrom in results;
  });

  if (ready.length === 0) {
    for (const s of remaining) await executeStep(s);
    break;
  }

  await Promise.all(ready.map(s => executeStep(s)));
  for (const s of ready) remaining.splice(remaining.indexOf(s), 1);
}

console.log(\`Tool sequence completed: \${successCount} succeeded, \${errorCount} failed out of \${steps.length} steps.\`);
console.log('');
console.log('Step details:');
console.log(outputs.join('\\n'));

if (Object.keys(results).length > 0) {
  console.log('');
  console.log('Saved results:');
  for (const [key, value] of Object.entries(results)) {
    const preview = typeof value === 'string' ? value.substring(0, 200) : JSON.stringify(value).substring(0, 200);
    console.log(\`  \${key}: \${preview}\`);
  }
}

console.log('');
console.log(\`Request: \${summaryPrompt}\`);
`;
  }
}

/**
 * Format a SandboxResult into a human-readable string for the LLM.
 * Shared by the execute_tool_sequence and execute_code handlers in main.ts.
 */
export const formatSandboxResult = (result: SandboxResult): string => {
  let responseText = '';
  if (result.error) {
    responseText = `Sandbox error: ${result.error}`;
    if (result.output) responseText += `\nOutput before error:\n${result.output}`;
  } else {
    responseText = result.output || '(no output)';
  }
  if (result.toolCalls > 0) {
    responseText += `\n(${result.toolCalls} tool call(s) executed)`;
  }
  return responseText;
};
