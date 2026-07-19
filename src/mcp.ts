import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { MCPConfig, MCPServerConfig, ToolSearchResult } from './interface';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export class MCPClientManager {
  private clients: Map<string, Client> = new Map();
  private config: MCPConfig = { servers: [] };
  private toolCache: Map<string, any> = new Map(); // Cache for tool definitions
  private configPath: string;
  // Track last used time for each server to implement idle timeout
  private serverLastUsed: Map<string, number> = new Map();
  // ID for the idle cleanup timer
  private idleCleanupTimer: NodeJS.Timeout | null = null;
  // Idle timeout in milliseconds (5 minutes)
  private readonly IDLE_TIMEOUT_MS = 5 * 60 * 1000;

  constructor(configPath: string = './mcp-servers.json') {
    this.configPath = configPath;
    this.loadConfig();
    // Start idle cleanup timer
    this.startIdleCleanup();
  }

  /**
   * Start the idle cleanup timer to disconnect unused servers
   */
  private startIdleCleanup(): void {
    // Clear existing timer if any
    if (this.idleCleanupTimer) {
      clearInterval(this.idleCleanupTimer);
    }

    // Check for idle servers every minute
    this.idleCleanupTimer = setInterval(() => {
      this.disconnectIdleServers();
    }, 60 * 1000); // Check every minute
  }

  /**
   * Disconnect servers that have been idle for too long
   */
  private disconnectIdleServers(): void {
    const now = Date.now();
    const serversToDisconnect: string[] = [];

    for (const [serverName, lastUsed] of this.serverLastUsed.entries()) {
      // Skip if server is not currently connected
      if (!this.clients.has(serverName)) continue;

      // Check if server has been idle for too long
      if (now - lastUsed > this.IDLE_TIMEOUT_MS) {
        serversToDisconnect.push(serverName);
      }
    }

    // Disconnect idle servers
    for (const serverName of serversToDisconnect) {
      this.disconnectServer(serverName);
      console.log(`Disconnected idle MCP server: ${serverName}`);
    }
  }

  /**
   * Disconnect a specific server and clean up its resources
   */
  private async disconnectServer(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (client) {
      try {
        await client.close();
        console.log(`Disconnected from MCP server: ${serverName}`);
      } catch (error) {
        console.error(`Error disconnecting from MCP server ${serverName}:`, error);
      }
    }

    // Remove from tracking
    this.clients.delete(serverName);
    this.serverLastUsed.delete(serverName);

    // Clear cache entries for this server
    for (const [key] of this.toolCache.entries()) {
      if (key.startsWith(`${serverName}:`)) {
        this.toolCache.delete(key);
      }
    }
  }

  private loadConfig(): void {
    try {
      const fullPath = join(process.cwd(), this.configPath);
      if (existsSync(fullPath)) {
        const configData = readFileSync(fullPath, 'utf8');
        this.config = JSON.parse(configData);
        console.log(`Loaded MCP configuration from ${fullPath}`);
      } else {
        console.warn(`MCP config file not found at ${fullPath}, using empty config`);
        this.config = { servers: [] };
      }
    } catch (error) {
      console.error('Failed to load MCP configuration:', error);
      this.config = { servers: [] };
    }
  }

  public async initialize(): Promise<void> {
    // Reload config in case it changed
    this.loadConfig();

    // Disconnect any existing clients (but don't connect automatically)
    // Connections will be established on-demand via ensureServerConnected
    await this.disconnectAll();

    // Clear tool cache when reconnecting
    this.toolCache.clear();

    // Note: We no longer automatically connect to all enabled servers on startup
    // Instead, connections are established on-demand when tools are requested
    // This implements dynamic server management as per MCP best practices
  }

  private async connectServer(serverConfig: MCPServerConfig): Promise<void> {
    const client = new Client({
      name: `mcp-client-${serverConfig.name}`,
      version: '1.0.0'
    });

    let transport;

    if (serverConfig.type === 'stdio') {
      if (!serverConfig.command) {
        throw new Error(`Command is required for stdio server ${serverConfig.name}`);
      }

      transport = new StdioClientTransport({
        command: serverConfig.command,
        args: serverConfig.args || [],
        env: serverConfig.env
      });
    } else if (serverConfig.type === 'sse') {
      if (!serverConfig.url) {
        throw new Error(`URL is required for SSE server ${serverConfig.name}`);
      }

      // Use StreamableHTTPClientTransport instead of deprecated SSEClientTransport
      // StreamableHTTP is the modern replacement that supports both HTTP and SSE internally
      transport = new StreamableHTTPClientTransport(new URL(serverConfig.url));
    } else {
      throw new Error(`Unsupported server type: ${serverConfig.type}`);
    }

    await client.connect(transport);
    this.clients.set(serverConfig.name, client);

    // Set up listeners for notifications
    // TODO: Implement proper notification handling for tools/list_changed
    // This requires accessing the underlying transport or using client-specific methods
    // For now, we'll rely on periodic cache refresh
  }

  public async disconnectAll(): Promise<void> {
    // Clear idle cleanup timer
    if (this.idleCleanupTimer) {
      clearInterval(this.idleCleanupTimer);
      this.idleCleanupTimer = null;
    }

    for (const [name, client] of this.clients.entries()) {
      try {
        await client.close();
        console.log(`Disconnected from MCP server: ${name}`);
      } catch (error) {
        console.error(`Error disconnecting from MCP server ${name}:`, error);
      }
    }
    this.clients.clear();
    this.serverLastUsed.clear();
  }

  public getClient(serverName: string): Client | undefined {
    const client = this.clients.get(serverName);
    if (client) {
      // Update last used time
      this.serverLastUsed.set(serverName, Date.now());
      return client;
    }
    return undefined;
  }

  /**
   * Ensure a server is connected, connecting it if necessary
   * @param serverName Name of the server to ensure is connected
   */
  public async ensureServerConnected(serverName: string): Promise<void> {
    // If already connected, just update the last used time
    if (this.clients.has(serverName)) {
      this.serverLastUsed.set(serverName, Date.now());
      return;
    }

    // Find the server configuration
    const serverConfig = this.config.servers.find(server => server.name === serverName);
    if (!serverConfig) {
      throw new Error(`MCP server configuration not found: ${serverName}`);
    }

    if (!serverConfig.enabled) {
      throw new Error(`MCP server is disabled: ${serverName}`);
    }

    // Connect to the server
    await this.connectServer(serverConfig);

    // Mark as recently used
    this.serverLastUsed.set(serverName, Date.now());
  }

  public getClients(): Map<string, Client> {
    return new Map(this.clients);
  }

  public getServerConfig(serverName: string): MCPServerConfig | undefined {
    return this.config.servers.find(server => server.name === serverName);
  }

  public getServerConfigs(): MCPServerConfig[] {
    return [...this.config.servers];
  }

  /**
       * Search for tools across all servers (connecting them on-demand if needed)
       * @param query Search query to match against tool names and descriptions
       * @param limit Maximum number of results to return
       * @returns Array of matching tools with basic info
       */
  public async searchTools(query: string, limit: number = 10): Promise<ToolSearchResult[]> {
    if (!query.trim()) {
      return [];
    }

    const results: ToolSearchResult[] = [];
    const queryLower = query.toLowerCase();

    // Track which servers we've attempted to connect to avoid repeated attempts
    const attemptedServers = new Set<string>();

    // Get tools from all configured servers (connecting on-demand)
    for (const serverConfig of this.config.servers) {
      if (!serverConfig.enabled) continue;

      const serverName = serverConfig.name;

      // Skip if we've already attempted to connect to this server
      if (attemptedServers.has(serverName)) continue;

      attemptedServers.add(serverName);

      try {
        // Ensure we're connected to this server
        await this.ensureServerConnected(serverName);

        const client = this.getClient(serverName);
        if (!client) continue;

        // Check cache first
        const cacheKey = `${serverName}:tools`;
        let toolsResponse;

        if (this.toolCache.has(cacheKey)) {
          toolsResponse = this.toolCache.get(cacheKey);
        } else {
          toolsResponse = await client.listTools();
          // Cache the results for 5 minutes
          this.toolCache.set(cacheKey, toolsResponse);
          setTimeout(() => {
            this.toolCache.delete(cacheKey);
          }, 5 * 60 * 1000);
        }

        // Enhanced search with token matching and basic scoring
        const queryTerms = queryLower.split(/\s+/).filter(term => term.length > 0);

        // Create array of results with scores for sorting
        const scoredResults = [];

        for (const tool of toolsResponse.tools) {
          const toolNameLower = tool.name.toLowerCase();
          const toolDescLower = (tool.description || '').toLowerCase();

          // Calculate relevance score
          let score = 0;

          // Exact phrase match gets highest score
          if (toolNameLower.includes(queryLower) || toolDescLower.includes(queryLower)) {
            score += 10;
          }

          // Check for individual term matches
          for (const term of queryTerms) {
            if (toolNameLower.includes(term)) {
              score += 3;
            }
            if (toolDescLower.includes(term)) {
              score += 1;
            }

            // Bonus for term at beginning of name/description
            if (toolNameLower.startsWith(term)) {
              score += 2;
            }
            if (toolDescLower.startsWith(term)) {
              score += 1;
            }
          }

          // Only include results with some relevance
          if (score > 0) {
            scoredResults.push({
              serverName,
              toolName: tool.name,
              description: tool.description || `No description available`,
              score: score
            });
          }
        }

        // Sort by relevance score (descending)
        scoredResults.sort((a, b) => b.score - a.score);

        // Extract just the needed fields (without score) and limit results
        const limitedResults = scoredResults
          .slice(0, limit)
          .map(({ serverName, toolName, description }) => ({
            serverName,
            toolName,
            description
          }));

        // Add the results to our results array
        results.push(...limitedResults);

        // Return early if we have enough results
        if (results.length >= limit) {
          return results.slice(0, limit);
        }
      } catch (error) {
        console.error(`Error searching tools on server ${serverName}:`, error);
        // Continue searching other servers
      }
    }

    return results.slice(0, limit);
  }

  /**
   * Get detailed information about a specific tool
   * @param serverName Name of the server hosting the tool
   * @param toolName Name of the tool
   * @returns Full tool definition including input/output schemas
   */
  public async getToolDetails(serverName: string, toolName: string): Promise<any> {
    const client = this.getClient(serverName);
    if (!client) {
      throw new Error(`MCP client for server ${serverName} not found`);
    }

    try {
      // Check cache first
      const cacheKey = `${serverName}:tool:${toolName}`;
      if (this.toolCache.has(cacheKey)) {
        return this.toolCache.get(cacheKey);
      }

      const toolsResponse = await client.listTools();
      const tool = toolsResponse.tools.find(t => t.name === toolName);

      if (!tool) {
        throw new Error(`Tool ${toolName} not found on server ${serverName}`);
      }

      // Cache the tool details
      this.toolCache.set(cacheKey, tool);
      setTimeout(() => {
        this.toolCache.delete(cacheKey);
      }, 5 * 60 * 1000); // 5 minutes

      return tool;
    } catch (error) {
      console.error(`Error getting tool details for ${serverName}/${toolName}:`, error);
      throw error;
    }
  }

  /**
   * Call a tool on a specific server
   * @param serverName Name of the server
   * @param toolName Name of the tool
   * @param args Arguments to pass to the tool
   * @returns Tool execution result
   */
  public async callTool(serverName: string, toolName: string, args: any): Promise<any> {
    const client = this.getClient(serverName);
    if (!client) {
      throw new Error(`MCP client for server ${serverName} not found`);
    }

    try {
      return await client.callTool({
        name: toolName,
        arguments: args
      });
    } catch (error) {
      console.error(`Error calling tool ${serverName}/${toolName}:`, error);
      throw error;
    }
  }

  public async refreshConfig(): Promise<void> {
    await this.disconnectAll();
    await this.initialize();
  }
}