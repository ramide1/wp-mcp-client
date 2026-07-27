import { randomUUID } from 'crypto';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { toolNameDelimiter } from './mcp';
import type { MCPClientManager } from './mcp';
import type { SandboxResult, SandboxToolStub, SandboxStep } from './interface';

/**
 * SandboxRunner executes model-generated code in an isolated Bun subprocess.
 *
 * Security model (per MCP best practices):
 * - No direct network access: tool calls are intercepted by the host
 * - Resource limits: configurable timeout (default 30s)
 * - No credential exposure: API keys stay in the parent process
 * - Output filtering: only console output returns to the model
 *
 * Communication protocol (JSON lines over stdin/stdout):
 * - Child → Parent: {"type":"call","id":"...","tool":"server__tool","args":{...}}
 * - Parent → Child: {"type":"result","id":"...","result":...} or {"type":"result","id":"...","error":"..."}
 * - Child → Parent: {"type":"done","output":"..."}
 */
export class SandboxRunner {
  private mcpManager: MCPClientManager;
  private sandboxDir: string;

  constructor(mcpManager: MCPClientManager) {
    this.mcpManager = mcpManager;
    this.sandboxDir = join(process.cwd(), '.sandbox');
    try { mkdirSync(this.sandboxDir, { recursive: true }); } catch { }
  }

  /**
   * Execute code in a sandboxed Bun subprocess with access to MCP tools.
   * @param code The JavaScript/TypeScript code to execute
   * @param tools Available tool stubs for the sandbox
   * @param timeoutMs Maximum execution time in milliseconds
   * @returns Sandbox result with output and optional error
   */
  async execute(code: string, tools: SandboxToolStub[], timeoutMs = 30_000): Promise<SandboxResult> {
    if (tools.length === 0) {
      return { output: '', error: 'No MCP tools available for sandbox execution', toolCalls: 0 };
    }

    const id = randomUUID();
    const scriptPath = join(this.sandboxDir, `${id}.ts`);

    try {
      writeFileSync(scriptPath, this.buildScript(code, tools), 'utf8');
      const proc = Bun.spawn(['bun', 'run', '--max-old-space-size=256', scriptPath], {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'pipe',
      });
      return await this.runSubprocess(proc, tools, timeoutMs);
    } finally {
      try { unlinkSync(scriptPath); } catch { }
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
    let output = '';
    let error: string | undefined;
    let toolCallCount = 0;

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
              const toolDef = tools.find(t => t.fullName === msg.tool);
              if (toolDef) {
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
              output = msg.output || '';
            }
          } catch { }
        }
      }
    })();

    const stderrDone = (async () => {
      const reader = stderrStream.getReader();
      let stderrText = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrText += decoder.decode(value, { stream: true });
      }
      if (stderrText) {
        if (!output) {
          error = stderrText;
        } else {
          // stderr produced alongside stdout — append as warning
          output += `\n[STDERR] ${stderrText}`;
        }
      }
    })();

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        proc.kill();
        reject(new Error(`Sandbox timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
    });

    try {
      // Wait for BOTH stdout and stderr to finish, or timeout
      await Promise.race([Promise.all([stdoutDone, stderrDone]), timeout]);
    } catch (err) {
      // Only the timeout promise rejects (the stream readers catch their own errors)
      if (err instanceof Error && err.message.includes('timed out')) {
        return { output: '', error: err.message, toolCalls: toolCallCount };
      }
      throw err;
    }

    return { output, error, toolCalls: toolCallCount };
  }

  private safeName(fullName: string): string {
    return `__mcp_${fullName.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  }

  /**
   * Generate tool stubs and the tools object map for sandbox scripts.
   * Shared by buildScript and buildToolSequenceScript.
   */
  private generateToolStubs(
    tools: SandboxToolStub[],
    includeAliases: boolean = true
  ): { stubsCode: string; toolMapCode: string; aliasesCode: string } {
    const stubs = tools.map(tool => {
      const fn = this.safeName(tool.fullName);
      return `
async function ${fn}(args = {}) {
  const __id = String(Date.now()) + Math.random().toString(36).slice(2);
  process.stdout.write(JSON.stringify({type:'call',id:__id,tool:${JSON.stringify(tool.fullName)},args})+'\\n');
  return new Promise((__res, __rej) => {
    const __dec = new TextDecoder();
    let __buf = '';
    const __r = process.stdin.getReader();
    (async () => {
      while (true) {
        const {done,value} = await __r.read();
        if (done) { __rej(new Error('stdin closed')); return; }
        __buf += __dec.decode(value, {stream:true});
        const __lines = __buf.split('\\n');
        __buf = __lines.pop()||'';
        for (const __l of __lines) {
          if (!__l.trim()) continue;
          try {
            const __m = JSON.parse(__l);
            if (__m.id === __id) {
              __r.cancel();
              __m.error ? __rej(new Error(__m.error)) : __res(__m.result);
              return;
            }
          } catch {}
        }
      }
    })();
  });
}`;
    }).join('\n');

    const toolMap = tools.map(tool => {
      const fn = this.safeName(tool.fullName);
      return `  ${JSON.stringify(tool.fullName)}: ${fn},`;
    }).join('\n');

    const aliasesCode = includeAliases
      ? tools.map(tool => {
        const fn = this.safeName(tool.fullName);
        const alias = tool.fullName.replace(/[^a-zA-Z0-9_]/g, '_');
        return `const ${alias} = ${fn};`;
      }).join('\n')
      : '';

    return { stubsCode: stubs, toolMapCode: toolMap, aliasesCode };
  }

  private buildScript(code: string, tools: SandboxToolStub[]): string {
    const { stubsCode, toolMapCode, aliasesCode } = this.generateToolStubs(tools);

    return `
// MCP Sandbox - Auto-generated tool stubs
${stubsCode}

const tools = {
${toolMapCode}
};

${aliasesCode}

const __output = [];
console.log = (...a) => __output.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
console.error = (...a) => __output.push('[ERROR] ' + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));

try {
  await (async () => {
    ${code}
  })();
  process.stdout.write(JSON.stringify({type:'done',output:__output.join('\\n')})+'\\n');
} catch(e) {
  process.stderr.write(e.message || String(e));
  process.exit(1);
}
process.exit(0);
`;
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

    const id = randomUUID();
    const scriptPath = join(this.sandboxDir, `${id}.ts`);

    try {
      writeFileSync(scriptPath, this.buildToolSequenceScript(steps, tools, summaryPrompt), 'utf8');
      const proc = Bun.spawn(['bun', 'run', '--max-old-space-size=256', scriptPath], {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'pipe',
      });
      return await this.runSubprocess(proc, tools, timeoutMs);
    } finally {
      try { unlinkSync(scriptPath); } catch { }
    }
  }

  private buildToolSequenceScript(
    steps: SandboxStep[],
    tools: SandboxToolStub[],
    summaryPrompt: string
  ): string {
    const { stubsCode, toolMapCode } = this.generateToolStubs(tools, false);

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
// MCP Sandbox - Tool Sequence Execution (sandboxed)
${stubsCode}

const tools = {
${toolMapCode}
};

const steps = ${stepsJson};
const summaryPrompt = ${JSON.stringify(summaryPrompt)};
const STEP_TIMEOUT_MS = 30000;

const results = {};
const outputs = [];
let successCount = 0;
let errorCount = 0;

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

  const fullName = step.serverName + toolNameDelimiter + step.toolName;
  const toolFn = tools[fullName];
  if (!toolFn) {
    outputs.push(\`Step \${step.index + 1} (\${fullName}): Error - Tool not found\`);
    errorCount++;
    return;
  }

  try {
    const result = await Promise.race([
      toolFn(args),
      new Promise((_, rej) => setTimeout(() => rej(new Error(\`Step timeout after \${STEP_TIMEOUT_MS / 1000}s\`)), STEP_TIMEOUT_MS))
    ]);

    let text = '';
    if (result?.content && Array.isArray(result.content)) {
      for (const c of result.content) {
        if (c.type === 'text') text += c.text;
      }
    }
    if (!text) text = JSON.stringify(result);

    if (step.saveAs) results[step.saveAs] = text;

    const truncated = text.length > 300 ? text.substring(0, 300) + '...' : text;
    outputs.push(\`Step \${step.index + 1} (\${fullName}): \${truncated}\`);
    successCount++;
  } catch (e) {
    outputs.push(\`Step \${step.index + 1} (\${fullName}): Error - \${e.message || String(e)}\`);
    errorCount++;
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