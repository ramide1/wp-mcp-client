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
  oauth?: McpOAuthConfig; // OAuth 2.1 configuration (streamable-http servers only)
};

/**
 * OAuth 2.1 configuration for a remote server.
 * `client_credentials` is used for machine to machine access, `authorization_code`
 * (with PKCE) for interactive access.
 */
export interface McpOAuthConfig {
  grant?: 'client_credentials' | 'authorization_code';
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  redirectUri?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  dynamicRegistration?: boolean;
  clientName?: string;
  tokenFile?: string;
}

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
  /** Number of indexed tools, or null when the server was never connected (unknown) */
  toolCount: number | null;
  type: 'stdio' | 'streamable-http';
};

// Structure for a tool ready to be sent to the LLM (direct loading mode)
export interface DirectToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>; // MCP spec: optional output schema for tool return type
  };
};

// Structure for a tool stub passed to the sandbox
export interface SandboxToolStub {
  fullName: string;
  serverName: string;
  toolName: string;
}

// A tool definition as returned by an MCP server
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  [key: string]: unknown;
}

// A content block of a tool result (text, image, audio or embedded resource)
export interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  resource?: unknown;
  [key: string]: unknown;
}

// The result of a tools/call request
export interface McpToolResult {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

// A resource exposed by an MCP server
export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  [key: string]: unknown;
}

// A resource template exposed by an MCP server
export interface McpResourceTemplate {
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
  [key: string]: unknown;
}

// A prompt exposed by an MCP server
export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  [key: string]: unknown;
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
  args: Record<string, unknown>;
  saveAs?: string;
  useResultFrom?: string;
  valid: boolean;
  error?: string;
}