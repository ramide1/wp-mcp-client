import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { MCPConfig, MCPServerConfig, ToolSearchResult } from './interface';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Tool name delimiter: used to separate serverName from toolName in MCP tool names
// Using :: to avoid ambiguity with tools that contain underscores in their names
const TOOL_NAME_DELIMITER = '::';

export class MCPClientManager {
  private clients: Map<string, Client> = new Map();
  private connectingServers: Map<string, Promise<void>> = new Map(); // Track in-flight connections
  private config: MCPConfig = { servers: [] };
  private toolCache: Map<string, any> = new Map(); // Cache for tool definitions
  private toolCacheTimestamps: Map<string, number> = new Map(); // Track when entries were added
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
   * Start the idle cleanup timer to disconnect unused servers and evict expired cache entries
   */
  private startIdleCleanup(): void {
    // Clear existing timer if any
    if (this.idleCleanupTimer) {
      clearInterval(this.idleCleanupTimer);
    }

    // Check for idle servers and expired cache every minute
    this.idleCleanupTimer = setInterval(() => {
      this.disconnectIdleServers();
      this.evictExpiredCache();
    }, 60 * 1000); // Check every minute
  }

  /**
   * Evict cache entries that have exceeded the TTL (5 minutes)
   */
  private evictExpiredCache(): void {
    const now = Date.now();
    const TTL_MS = 5 * 60 * 1000;
    const keysToDelete: string[] = [];

    for (const [key, timestamp] of this.toolCacheTimestamps.entries()) {
      if (now - timestamp > TTL_MS) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.toolCache.delete(key);
      this.toolCacheTimestamps.delete(key);
    }

    if (keysToDelete.length > 0) {
      console.log(`Evicted ${keysToDelete.length} expired cache entries`);
    }
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
      this.disconnectServer(serverName).then(() => {
        console.log(`Disconnected idle MCP server: ${serverName}`);
      }).catch(error => {
        console.error(`Error disconnecting idle MCP server ${serverName}:`, error);
      });
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
    this.invalidateServerCache(serverName);
  }

  /**
   * Invalidate all cache entries for a specific server
   * Called when tools/list_changed notification is received
   */
  private invalidateServerCache(serverName: string): void {
    const keysToDelete: string[] = [];
    for (const [key] of this.toolCache.entries()) {
      if (key.startsWith(`${serverName}:`)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.toolCache.delete(key);
      this.toolCacheTimestamps.delete(key);
    }
    if (keysToDelete.length > 0) {
      console.log(`Invalidated ${keysToDelete.length} cache entries for server ${serverName}`);
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
    this.toolCacheTimestamps.clear();

    // Note: We no longer automatically connect to all enabled servers on startup
    // Instead, connections are established on-demand when tools are requested
    // This implements dynamic server management as per MCP best practices

    // Restart idle cleanup timer (disconnectAll clears it)
    this.startIdleCleanup();
  }

  private async connectServer(serverConfig: MCPServerConfig): Promise<void> {
    const client = new Client(
      { name: `mcp-client-${serverConfig.name}`, version: '1.0.0' },
      {
        // Handle tools/list_changed notifications from the server
        // This invalidates the tool cache when the server's tool list changes
        listChanged: {
          tools: {
            onChanged: (error, tools) => {
              if (error) {
                console.error(`Error receiving tools/list_changed from ${serverConfig.name}:`, error);
                return;
              }
              console.log(`Tools list changed on server ${serverConfig.name}, refreshing cache...`);
              // Invalidate cache for this server
              this.invalidateServerCache(serverConfig.name);
            }
          }
        }
      }
    );

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
    this.connectingServers.clear();
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
   * Ensure a server is connected, connecting it if necessary.
   * Concurrent calls for the same server will wait for the in-flight connection.
   * @param serverName Name of the server to ensure is connected
   */
  public async ensureServerConnected(serverName: string): Promise<void> {
    // If already connected, just update the last used time
    if (this.clients.has(serverName)) {
      this.serverLastUsed.set(serverName, Date.now());
      return;
    }

    // If a connection is already in progress, wait for it
    const inFlight = this.connectingServers.get(serverName);
    if (inFlight) {
      await inFlight;
      // After waiting, check again in case the connection succeeded
      if (this.clients.has(serverName)) {
        this.serverLastUsed.set(serverName, Date.now());
        return;
      }
    }

    // Find the server configuration
    const serverConfig = this.config.servers.find(server => server.name === serverName);
    if (!serverConfig) {
      throw new Error(`MCP server configuration not found: ${serverName}`);
    }

    if (!serverConfig.enabled) {
      throw new Error(`MCP server is disabled: ${serverName}`);
    }

    // Track the in-flight connection
    const connectPromise = this.connectServer(serverConfig).finally(() => {
      this.connectingServers.delete(serverName);
    });
    this.connectingServers.set(serverName, connectPromise);

    await connectPromise;

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

        const client = this.getClient(serverName)!; // Guaranteed to exist after ensureServerConnected

        // Check cache first
        const cacheKey = `${serverName}:tools`;
        let toolsResponse;

        if (this.toolCache.has(cacheKey)) {
          toolsResponse = this.toolCache.get(cacheKey);
        } else {
          toolsResponse = await client.listTools();
          // Cache the results (evicted by interval-based TTL)
          this.toolCache.set(cacheKey, toolsResponse);
          this.toolCacheTimestamps.set(cacheKey, Date.now());
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
    await this.ensureServerConnected(serverName);
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

      // Cache the tool details (evicted by interval-based TTL)
      this.toolCache.set(cacheKey, tool);
      this.toolCacheTimestamps.set(cacheKey, Date.now());

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
    await this.ensureServerConnected(serverName);
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

  /**
   * Get the full tool name with server prefix using the delimiter
   * @param serverName Name of the server
   * @param toolName Name of the tool
   * @returns Full tool name in format "serverName::toolName"
   */
  public static getFullToolName(serverName: string, toolName: string): string {
    return `${serverName}${TOOL_NAME_DELIMITER}${toolName}`;
  }

  /**
   * Parse a full tool name into server name and tool name
   * @param fullToolName Full tool name in format "serverName::toolName"
   * @returns Object with serverName and toolName, or null if parsing fails
   */
  public static parseToolName(fullToolName: string): { serverName: string; toolName: string } | null {
    const delimiterIndex = fullToolName.indexOf(TOOL_NAME_DELIMITER);
    if (delimiterIndex === -1) {
      return null;
    }
    const serverName = fullToolName.substring(0, delimiterIndex);
    const toolName = fullToolName.substring(delimiterIndex + TOOL_NAME_DELIMITER.length);
    if (serverName && toolName) {
      return { serverName, toolName };
    }
    return null;
  }
}