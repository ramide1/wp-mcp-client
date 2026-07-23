export interface MCPServerConfig {
  name: string;
  type: 'stdio' | 'streamable-http'; // stdio for local processes, streamable-http for remote servers
  command?: string; // For stdio: the command to run (e.g., "npx", "python")
  args?: string[]; // Arguments for the command
  url?: string; // For streamable-http: the server URL
  headers?: Record<string, string>; // For streamable-http: custom headers (e.g., Authorization)
  env?: Record<string, string>; // Environment variables for stdio servers
  enabled: boolean; // Whether this server should be connected
  description?: string; // Human-readable description of what this server provides
};

export interface MCPConfig {
  servers: MCPServerConfig[];
};

// Detail level for search results (per MCP best practices: multiple detail levels)
export type SearchDetailLevel = 'minimal' | 'basic' | 'full';

// Tool search result with optional schema details
export interface ToolSearchResultDetailed {
  serverName: string;
  toolName: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

// Structure for server info returned by search_available_servers
export interface ServerInfo {
  name: string;
  description: string;
  connected: boolean;
  toolCount: number;
  type: 'stdio' | 'streamable-http';
};

// Structure for a tool ready to be sent to the LLM (direct loading mode)
export interface DirectToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
  };
};

// Structure for a tool stub passed to the sandbox
export interface SandboxToolStub {
  fullName: string;
  serverName: string;
  toolName: string;
}

// Structure for sandbox execution result
export interface SandboxResult {
  output: string;
  error?: string;
  toolCalls: number;
};

export interface SandboxStep {
  index: number;
  serverName: string;
  toolName: string;
  args: any;
  saveAs?: string;
  useResultFrom?: string;
  valid: boolean;
  error?: string;
}