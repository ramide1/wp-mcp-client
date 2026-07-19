interface MCPServerConfig {
  name: string;
  type: 'stdio' | 'sse'; // stdio for local processes, sse for remote servers
  command?: string; // For stdio: the command to run (e.g., "npx", "python")
  args?: string[]; // Arguments for the command
  url?: string; // For sse: the server URL
  env?: Record<string, string>; // Environment variables for stdio servers
  enabled: boolean; // Whether this server should be connected
}
interface MCPConfig {
  servers: MCPServerConfig[];
}

// Define the structure for tool search results
interface ToolSearchResult {
  serverName: string;
  toolName: string;
  description: string;
  // We don't include the full schema here to keep search results lightweight
}

export type { MCPServerConfig, MCPConfig, ToolSearchResult }