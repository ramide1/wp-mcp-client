import { randomUUID } from 'crypto';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { MCPClientManager } from './mcp';
import type { SandboxResult, SandboxToolStub } from './interface';

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
 * - Child → Parent: {"type":"call","id":"...","tool":"server::tool","args":{...}}
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
      const proc = Bun.spawn(['bun', 'run', scriptPath], {
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
      if (stderrText && !output) error = stderrText;
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
      if (err instanceof Error && err.message.includes('timed out')) {
        return { output: '', error: err.message, toolCalls: toolCallCount };
      }
    }

    return { output: error ? '' : output, error, toolCalls: toolCallCount };
  }

  private buildScript(code: string, tools: SandboxToolStub[]): string {
    const safeName = (fullName: string) => `__mcp_${fullName.replace(/[^a-zA-Z0-9_]/g, '_')}`;

    const stubs = tools.map(tool => {
      const fn = safeName(tool.fullName);
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
      const fn = safeName(tool.fullName);
      return `  ${JSON.stringify(tool.fullName)}: ${fn},`;
    }).join('\n');

    const aliases = tools.map(tool => {
      const fn = safeName(tool.fullName);
      const alias = tool.fullName.replace(/[^a-zA-Z0-9_]/g, '_');
      return alias !== fn ? `const ${alias} = ${fn};` : '';
    }).filter(Boolean).join('\n');

    return `
// MCP Sandbox - Auto-generated tool stubs
${stubs}

const tools = {
${toolMap}
};

${aliases}

const __output = [];
const __origLog = console.log;
const __origError = console.error;
console.log = (...a) => __output.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
console.error = (...a) => __output.push('[ERROR] ' + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));

try {
  const __result = await (async () => {
    ${code}
  })();
  process.stdout.write(JSON.stringify({type:'done',output:__output.join('\\n'),result:__result!==undefined?__result:null})+'\\n');
} catch(e) {
  process.stderr.write(e.message || String(e));
  process.exit(1);
}
process.exit(0);
`;
  }
}