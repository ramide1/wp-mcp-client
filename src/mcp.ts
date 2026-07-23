import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { MCPConfig, MCPServerConfig, ToolSearchResultDetailed, SearchDetailLevel, ServerInfo, DirectToolDefinition, SandboxToolStub } from './interface';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Tool name delimiter: used to separate serverName from toolName in MCP tool names
// Using __ (double underscore) to comply with MCP spec tool name format [a-zA-Z0-9_-]+
// Single _ is also valid but __ makes the boundary clearer
export const toolNameDelimiter = '__';

export class MCPClientManager {
  private clients: Map<string, Client> = new Map();
  private connectingServers: Map<string, Promise<void>> = new Map(); // Track in-flight connections
  private disconnectingServers: Set<string> = new Set(); // Track in-flight disconnects
  private config: MCPConfig = { servers: [] };
  // LRU tool cache: Map preserves insertion order; on access, entry is moved to end (most recently used).
  // On eviction, entries are removed from the beginning (least recently used).
  private toolCache: Map<string, { data: any; timestamp: number }> = new Map();
  private readonly MAX_CACHE_ENTRIES = 1000; // Max cache entries before LRU eviction
  private configPath: string;
  // Track last used time for each server to implement idle timeout
  private serverLastUsed: Map<string, number> = new Map();
  // ID for the idle cleanup timer
  private idleCleanupTimer: ReturnType<typeof setInterval> | null = null;
  // Guard to prevent overlapping async cleanup runs
  private idleCleanupRunning: boolean = false;
  // Idle timeout in milliseconds (5 minutes)
  private readonly IDLE_TIMEOUT_MS = 5 * 60 * 1000;
  // Cache TTL in milliseconds (configurable via CACHE_TTL env var, default 5 minutes)
  private readonly CACHE_TTL_MS: number;
  // Cleanup interval: proportional to TTL (1/10th), clamped between 10s and 60s
  private readonly CLEANUP_INTERVAL_MS: number;
  // Lightweight server registry: stores tool metadata without full connections
  // Populated lazily when a server is first connected; used by searchTools
  // to avoid connecting to every server on each search query
  private serverRegistry: Map<string, { description: string; tools: Array<{ name: string; description: string }> }> = new Map();
  // Cache for getAllToolsForDirectLoading results (invalidated on list_changed)
  private directLoadingCache: DirectToolDefinition[] | null = null;

  constructor(configPath: string = './mcp-servers.json') {
    this.configPath = configPath;
    this.CACHE_TTL_MS = parseInt(process.env.CACHE_TTL ?? '') || 5 * 60 * 1000;
    // Cleanup interval: 1/10th of TTL, clamped between 10s and 60s
    this.CLEANUP_INTERVAL_MS = Math.min(Math.max(this.CACHE_TTL_MS / 10, 10_000), 60_000);
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

    // Check for idle servers and expired cache at interval proportional to TTL
    this.idleCleanupTimer = setInterval(() => {
      this.disconnectIdleServers();
      this.evictExpiredCache();
    }, this.CLEANUP_INTERVAL_MS);
  }

  /**
   * Touch a cache entry to mark it as most recently used (LRU).
   * Deletes and re-inserts the entry to move it to the end of the Map's iteration order.
   */
  private touchCache(key: string): void {
    const entry = this.toolCache.get(key);
    if (entry) {
      this.toolCache.delete(key);
      this.toolCache.set(key, entry);
    }
  }

  /**
   * Evict cache entries that have exceeded the TTL, then enforce max size via LRU.
   */
  private evictExpiredCache(): void {
    const now = Date.now();
    let evictedCount = 0;

    // Phase 1: Evict entries that exceeded the TTL (iterate oldest first)
    const expiredKeys: string[] = [];
    for (const [key, entry] of this.toolCache.entries()) {
      if (now - entry.timestamp > this.CACHE_TTL_MS) {
        expiredKeys.push(key);
      }
    }

    for (const key of expiredKeys) {
      this.toolCache.delete(key);
    }
    evictedCount += expiredKeys.length;

    // Phase 2: Evict LRU entries (from beginning of Map) if cache exceeds max size
    if (this.toolCache.size > this.MAX_CACHE_ENTRIES) {
      const excess = this.toolCache.size - this.MAX_CACHE_ENTRIES;
      const iter = this.toolCache.keys();
      for (let i = 0; i < excess; i++) {
        const { value: key, done } = iter.next();
        if (done || !key) break;
        this.toolCache.delete(key);
      }
      evictedCount += excess;
    }

    if (evictedCount > 0) {
      console.log(`Evicted ${evictedCount} expired cache entries`);
    }
  }

  /**
   * Disconnect servers that have been idle for too long
   */
  private async disconnectIdleServers(): Promise<void> {
    // Prevent overlapping cleanup runs (async interval protection)
    if (this.idleCleanupRunning) return;
    this.idleCleanupRunning = true;

    try {
      const now = Date.now();
      const serversToDisconnect: string[] = [];

      for (const [serverName, lastUsed] of this.serverLastUsed.entries()) {
        // Skip if server is not currently connected
        if (!this.clients.has(serverName)) continue;

        // Skip if already being disconnected
        if (this.disconnectingServers.has(serverName)) continue;

        // Check if server has been idle for too long
        if (now - lastUsed > this.IDLE_TIMEOUT_MS) {
          serversToDisconnect.push(serverName);
        }
      }

      // Disconnect idle servers sequentially to avoid races
      for (const serverName of serversToDisconnect) {
        this.disconnectingServers.add(serverName);
        try {
          await this.disconnectServer(serverName);
          console.log(`Disconnected idle MCP server: ${serverName}`);
        } catch (error) {
          console.error(`Error disconnecting idle MCP server ${serverName}:`, error);
        } finally {
          this.disconnectingServers.delete(serverName);
        }
      }
    } finally {
      this.idleCleanupRunning = false;
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

    // Remove from tracking (keep registry for fast searches without reconnecting)
    this.clients.delete(serverName);
    this.serverLastUsed.delete(serverName);

    // Clear cache entries for this server
    this.invalidateServerCache(serverName);
  }

  /**
   * Refresh the lightweight registry for a specific server.
   * Called when tools/list_changed notification is received to re-index the catalog.
   * Per MCP best practices: "Re-index the search catalog when a server sends
   * notifications/tools/list_changed."
   */
  private async refreshServerRegistry(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (!client) return;

    try {
      const toolsResponse = await client.listTools();
      const toolSummaries = toolsResponse.tools.map((t: any) => ({
        name: t.name,
        description: t.description || ''
      }));
      this.serverRegistry.set(serverName, {
        description: this.serverRegistry.get(serverName)?.description || `MCP server: ${serverName}`,
        tools: toolSummaries
      });
      // Also refresh the full tools cache
      const cacheKey = `${serverName}:tools`;
      this.toolCache.set(cacheKey, { data: toolsResponse, timestamp: Date.now() });
      console.log(`Re-indexed registry for server ${serverName}: ${toolSummaries.length} tools`);
    } catch (error) {
      console.error(`Error re-indexing registry for ${serverName}:`, error);
    }
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
    }
    // Also invalidate directLoadingCache since server tools changed
    this.directLoadingCache = null;
    // Registry persists to enable fast searches without reconnecting
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
    this.serverRegistry.clear();
    this.directLoadingCache = null;

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
        // Invalidates the tool cache and re-indexes the registry when the server's tool list changes
        // autoRefresh: false because we handle the refresh manually in onChanged
        // to avoid double listTools() calls (SDK default autoRefresh would also call listTools)
        listChanged: {
          tools: {
            autoRefresh: false,
            onChanged: (error, tools) => {
              if (error) {
                console.error(`Error receiving tools/list_changed from ${serverConfig.name}:`, error);
                return;
              }
              console.log(`Tools list changed on server ${serverConfig.name}, refreshing cache...`);
              // Invalidate cache for this server
              this.invalidateServerCache(serverConfig.name);
              // Re-index the registry so searchTools sees the updated tool list
              this.refreshServerRegistry(serverConfig.name).catch((err) => {
                console.error(`Failed to re-index registry for ${serverConfig.name}:`, err);
              });
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
    } else if (serverConfig.type === 'streamable-http') {
      if (!serverConfig.url) {
        throw new Error(`URL is required for streamable-http server ${serverConfig.name}`);
      }

      // StreamableHTTPClientTransport is the modern transport that supports both HTTP and SSE internally
      transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
        ...(serverConfig.headers ? {
          requestInit: {
            headers: serverConfig.headers
          }
        } : {})
      });
    } else {
      throw new Error(`Unsupported server type: ${serverConfig.type}`);
    }

    await client.connect(transport);
    this.clients.set(serverConfig.name, client);

    // Populate lightweight registry with tool metadata (no full schema)
    try {
      const toolsResponse = await client.listTools();
      const toolSummaries = toolsResponse.tools.map((t: any) => ({
        name: t.name,
        description: t.description || ''
      }));
      this.serverRegistry.set(serverConfig.name, {
        description: serverConfig.description || `MCP server: ${serverConfig.name} (${serverConfig.type})`,
        tools: toolSummaries
      });
      // Also cache the full tools list for other consumers
      const cacheKey = `${serverConfig.name}:tools`;
      this.toolCache.set(cacheKey, { data: toolsResponse, timestamp: Date.now() });
    } catch (error) {
      console.error(`Error populating registry for ${serverConfig.name}:`, error);
    }
  }

  public async disconnectAll(): Promise<void> {
    // Clear idle cleanup timer
    if (this.idleCleanupTimer) {
      clearInterval(this.idleCleanupTimer);
      this.idleCleanupTimer = null;
    }

    // Wait for any in-flight connections to complete before closing
    const inFlight = [...this.connectingServers.values()];
    if (inFlight.length > 0) {
      await Promise.allSettled(inFlight);
    }
    this.connectingServers.clear();
    this.disconnectingServers.clear();

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
    // Registry persists for fast searches without reconnecting
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

  public getServerConfig(serverName: string): MCPServerConfig | undefined {
    return this.config.servers.find(server => server.name === serverName);
  }

  /**
   * Calculate Levenshtein distance between two strings (for fuzzy matching)
   */
  private levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = [];
    for (let i = 0; i <= m; i++) {
      dp[i] = new Array<number>(n + 1).fill(0);
    }

    for (let i = 0; i <= m; i++) dp[i]![0] = i;
    for (let j = 0; j <= n; j++) dp[0]![j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i]![j] = dp[i - 1]![j - 1]!;
        } else {
          dp[i]![j] = 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
        }
      }
    }
    return dp[m]![n]!;
  }

  /**
   * Check if two terms are fuzzy matches (within edit distance threshold)
   */
  private isFuzzyMatch(term: string, target: string, maxDistance: number = 2): boolean {
    if (target.length < 3 || term.length < 3) return false;
    // For short terms, require exact prefix or very close match
    if (term.length <= 4) return this.levenshteinDistance(term, target) <= 1;
    return this.levenshteinDistance(term, target) <= maxDistance;
  }

  /**
   * Common verb/noun synonyms for tool search (Spanish + English)
   */
  private readonly synonyms: Record<string, string[]> = {
    // Spanish -> English equivalents
    'crear': ['create', 'make', 'add', 'new'],
    'buscar': ['search', 'find', 'query', 'lookup', 'get'],
    'eliminar': ['delete', 'remove', 'destroy', 'drop'],
    'actualizar': ['update', 'modify', 'edit', 'change', 'set'],
    'leer': ['read', 'get', 'fetch', 'load', 'open'],
    'escribir': ['write', 'save', 'store', 'put'],
    'listar': ['list', 'get', 'fetch', 'show', 'enumerate'],
    'enviar': ['send', 'post', 'dispatch'],
    'recibir': ['receive', 'get', 'fetch', 'poll'],
    'archivos': ['files', 'filesystem', 'file', 'documents'],
    'carpetas': ['folders', 'directory', 'directories'],
    'usuarios': ['users', 'accounts', 'people', 'persons'],
    'mensajes': ['messages', 'msgs', 'notifications'],
    'datos': ['data', 'info', 'information', 'records'],
    'configuracion': ['config', 'configuration', 'settings', 'preferences'],
    'consulta': ['query', 'search', 'lookup', 'find'],
    'reporte': ['report', 'summary', 'stats', 'statistics'],
    // English equivalents
    'create': ['crear', 'make', 'add', 'new'],
    'search': ['buscar', 'find', 'query', 'lookup', 'get'],
    'delete': ['eliminar', 'remove', 'destroy', 'drop'],
    'update': ['actualizar', 'modify', 'edit', 'change', 'set'],
    'read': ['leer', 'get', 'fetch', 'load', 'open'],
    'write': ['escribir', 'save', 'store', 'put'],
    'list': ['listar', 'get', 'fetch', 'show', 'enumerate'],
    'send': ['enviar', 'post', 'dispatch'],
    'receive': ['recibir', 'get', 'fetch', 'poll'],
    'files': ['archivos', 'filesystem', 'file', 'documents'],
    'folders': ['carpetas', 'directory', 'directories'],
    'users': ['usuarios', 'accounts', 'people', 'persons'],
    'messages': ['mensajes', 'msgs', 'notifications'],
    'data': ['datos', 'info', 'information', 'records'],
    'config': ['configuracion', 'configuration', 'settings'],
    'query': ['consulta', 'search', 'lookup', 'find'],
    'report': ['reporte', 'summary', 'stats'],
  };

  /**
   * Expand a search query with synonyms
   */
  private expandWithSynonyms(terms: string[]): string[] {
    const expanded = new Set<string>(terms);
    for (const term of terms) {
      const syns = this.synonyms[term.toLowerCase()];
      if (syns) {
        for (const syn of syns) {
          expanded.add(syn.toLowerCase());
        }
      }
    }
    return Array.from(expanded);
  }

  /**
   * Search for tools across servers using the lightweight registry.
   * First searches already-connected servers (registry) without connection overhead.
   * Only connects to unregistered servers as a fallback if results are insufficient.
   * Uses keyword matching with fuzzy matching and synonym expansion.
   * @param query Search query to match against tool names and descriptions
   * @param limit Maximum number of results to return
   * @param detailLevel Level of detail in results: 'minimal' | 'basic' | 'full'
   * @returns Array of matching tools with info based on detail level
   */
  public async searchTools(
    query: string,
    limit: number = 10,
    detailLevel: SearchDetailLevel = 'basic'
  ): Promise<ToolSearchResultDetailed[]> {
    if (!query.trim()) {
      return [];
    }

    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(term => term.length > 0);
    const expandedTerms = this.expandWithSynonyms(queryTerms);

    const scoreTool = (toolName: string, toolDesc: string): number => {
      const toolNameLower = toolName.toLowerCase();
      const toolDescLower = (toolDesc || '').toLowerCase();
      let score = 0;

      // Exact match bonus
      if (toolNameLower.includes(queryLower) || toolDescLower.includes(queryLower)) {
        score += 20;
      }
      // Expanded terms (synonyms)
      for (const expandedTerm of expandedTerms) {
        if (toolNameLower.includes(expandedTerm)) score += 5;
        if (toolDescLower.includes(expandedTerm)) score += 3;
      }
      // Individual terms
      for (const term of queryTerms) {
        if (toolNameLower.includes(term)) score += 3;
        if (toolDescLower.includes(term)) score += 1;
        if (toolNameLower.startsWith(term)) score += 2;
        if (toolDescLower.startsWith(term)) score += 1;
      }
      // Fuzzy matching
      for (const term of queryTerms) {
        if (term.length < 3) continue;
        const nameParts = toolNameLower.split(/[_\-./\s]/);
        for (const part of nameParts) {
          if (this.isFuzzyMatch(term, part)) { score += 2; break; }
        }
        if (this.isFuzzyMatch(term, toolDescLower.substring(0, 50), 3)) score += 1;
      }
      return score;
    };

    // Helper to build result based on detail level
    const buildResult = (serverName: string, tool: { name: string; description: string }, fullTool?: any): ToolSearchResultDetailed => {
      const base: ToolSearchResultDetailed = {
        serverName,
        toolName: tool.name,
        description: detailLevel === 'minimal' ? '' : (tool.description || 'No description available'),
      };
      if (detailLevel === 'full' && fullTool) {
        base.inputSchema = fullTool.inputSchema;
        base.outputSchema = fullTool.outputSchema;
      }
      return base;
    };

    // Phase 1: Search the lightweight registry (connected servers, no I/O)
    const results: Array<ToolSearchResultDetailed & { score: number }> = [];
    for (const [serverName, entry] of this.serverRegistry.entries()) {
      const serverConfig = this.config.servers.find(s => s.name === serverName);
      if (!serverConfig?.enabled) continue;

      for (const tool of entry.tools) {
        const score = scoreTool(tool.name, tool.description);
        if (score > 0) {
          let fullTool: any = undefined;
          if (detailLevel === 'full') {
            // Get full tool from cache if available
            const cacheKey = `${serverName}:tools`;
            const cached = this.toolCache.get(cacheKey);
            fullTool = cached?.data?.tools?.find((t: any) => t.name === tool.name);
          }
          results.push({ ...buildResult(serverName, tool, fullTool), score });
        }
      }
      if (results.length >= limit * 2) break; // Get extra for sorting
    }

    // Phase 2: Connect to unregistered servers only if results are insufficient.
    // Limit connection attempts to avoid connecting to every server on each search.
    const MAX_PHASE2_ATTEMPTS = 3;
    let phase2Attempts = 0;
    if (results.length < limit) {
      for (const serverConfig of this.config.servers) {
        if (phase2Attempts >= MAX_PHASE2_ATTEMPTS) break;
        if (results.length >= limit * 2) break;
        if (!serverConfig.enabled) continue;
        if (this.serverRegistry.has(serverConfig.name)) continue;

        phase2Attempts++;
        try {
          await this.ensureServerConnected(serverConfig.name);
          const entry = this.serverRegistry.get(serverConfig.name);
          if (!entry) continue;

          for (const tool of entry.tools) {
            const score = scoreTool(tool.name, tool.description);
            if (score > 0) {
              let fullTool: any = undefined;
              if (detailLevel === 'full') {
                const cacheKey = `${serverConfig.name}:tools`;
                const cached = this.toolCache.get(cacheKey);
                fullTool = cached?.data?.tools?.find((t: any) => t.name === tool.name);
              }
              results.push({ ...buildResult(serverConfig.name, tool, fullTool), score });
            }
          }
        } catch (error) {
          console.error(`Error searching tools on server ${serverConfig.name}:`, error);
        }
      }
    }

    // Sort by score and return top results
    results.sort((a, b) => b.score - a.score);
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

    // Check tool-specific cache first
    const detailCacheKey = `${serverName}:tool:${toolName}`;
    const cachedDetail = this.toolCache.get(detailCacheKey);
    if (cachedDetail !== undefined) {
      this.touchCache(detailCacheKey);
      return cachedDetail.data;
    }

    // Reuse the cached tools list instead of calling listTools() again
    const listCacheKey = `${serverName}:tools`;
    let toolsResponse;
    const cachedEntry = this.toolCache.get(listCacheKey);
    if (cachedEntry !== undefined) {
      toolsResponse = cachedEntry.data;
      this.touchCache(listCacheKey);
    } else {
      const client = this.getClient(serverName);
      if (!client) {
        throw new Error(`MCP client for server ${serverName} not found`);
      }
      toolsResponse = await client.listTools();
      this.toolCache.set(listCacheKey, { data: toolsResponse, timestamp: Date.now() });
    }

    const tool = toolsResponse.tools.find((t: any) => t.name === toolName);
    if (!tool) {
      throw new Error(`Tool ${toolName} not found on server ${serverName}`);
    }

    // Cache the tool details (evicted by LRU)
    this.toolCache.set(detailCacheKey, { data: tool, timestamp: Date.now() });
    return tool;
  }

  /**
   * Validate tool arguments against its input schema (JSON Schema draft-07).
   * Returns an array of validation error messages. Empty array means valid.
   */
  private validateArgs(args: Record<string, unknown>, schema: any): string[] {
    const errors: string[] = [];
    if (!schema || typeof schema !== 'object') return errors;

    const required: string[] = Array.isArray(schema.required) ? schema.required : [];
    const properties: Record<string, any> = schema.properties || {};

    // Check required fields
    for (const field of required) {
      if (!(field in args) || args[field] === undefined) {
        errors.push(`missing required field '${field}'`);
      }
    }

    // Validate types and constraints
    for (const [key, value] of Object.entries(args)) {
      const propSchema = properties[key];
      if (!propSchema) continue; // no schema for this property, skip

      // Type check
      if (propSchema.type) {
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        if (actualType !== propSchema.type) {
          // Allow number to pass as integer
          if (!(propSchema.type === 'integer' && actualType === 'number' && Number.isInteger(value as number))) {
            errors.push(`field '${key}' expected type ${propSchema.type}, got ${actualType}`);
            continue;
          }
        }
      }

      // Enum check
      if (propSchema.enum && Array.isArray(propSchema.enum)) {
        if (!propSchema.enum.includes(value)) {
          errors.push(`field '${key}' must be one of: ${propSchema.enum.join(', ')}`);
        }
      }

      // String length constraints
      if (propSchema.type === 'string' && typeof value === 'string') {
        if (propSchema.minLength !== undefined && value.length < propSchema.minLength) {
          errors.push(`field '${key}' must have at least ${propSchema.minLength} characters`);
        }
        if (propSchema.maxLength !== undefined && value.length > propSchema.maxLength) {
          errors.push(`field '${key}' must have at most ${propSchema.maxLength} characters`);
        }
      }

      // Number/integer range constraints
      if ((propSchema.type === 'number' || propSchema.type === 'integer') && typeof value === 'number') {
        if (propSchema.minimum !== undefined && value < propSchema.minimum) {
          errors.push(`field '${key}' must be >= ${propSchema.minimum}`);
        }
        if (propSchema.maximum !== undefined && value > propSchema.maximum) {
          errors.push(`field '${key}' must be <= ${propSchema.maximum}`);
        }
      }

      // Array constraints
      if (propSchema.type === 'array' && Array.isArray(value)) {
        if (propSchema.minItems !== undefined && value.length < propSchema.minItems) {
          errors.push(`field '${key}' must have at least ${propSchema.minItems} items`);
        }
        if (propSchema.maxItems !== undefined && value.length > propSchema.maxItems) {
          errors.push(`field '${key}' must have at most ${propSchema.maxItems} items`);
        }
        if (propSchema.uniqueItems === true) {
          const seen = new Set<string>();
          for (const item of value) {
            const serialized = JSON.stringify(item);
            if (seen.has(serialized)) {
              errors.push(`field '${key}' must contain unique items`);
              break;
            }
            seen.add(serialized);
          }
        }
      }

      // Pattern validation (regex)
      if (propSchema.pattern && typeof value === 'string') {
        try {
          const regex = new RegExp(propSchema.pattern);
          if (!regex.test(value)) {
            errors.push(`field '${key}' does not match pattern: ${propSchema.pattern}`);
          }
        } catch {
          // Invalid regex in schema — skip validation rather than blocking
        }
      }

      // Object property count
      if (propSchema.type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const propCount = Object.keys(value).length;
        if (propSchema.minProperties !== undefined && propCount < propSchema.minProperties) {
          errors.push(`field '${key}' must have at least ${propSchema.minProperties} properties`);
        }
        if (propSchema.maxProperties !== undefined && propCount > propSchema.maxProperties) {
          errors.push(`field '${key}' must have at most ${propSchema.maxProperties} properties`);
        }
      }
    }

    return errors;
  }

  /**
   * Call a tool on a specific server
   * @param serverName Name of the server
   * @param toolName Name of the tool
   * @param args Arguments to pass to the tool
   * @returns Tool execution result
   * @throws Error if the tool returns isError: true (per MCP spec)
   * @throws Error if arguments fail schema validation
   */
  public async callTool(serverName: string, toolName: string, args: any): Promise<any> {
    await this.ensureServerConnected(serverName);
    const client = this.getClient(serverName);
    if (!client) {
      throw new Error(`MCP client for server ${serverName} not found`);
    }

    // Validate args against tool's input schema before sending to server
    try {
      const toolDetails = await this.getToolDetails(serverName, toolName);
      if (toolDetails?.inputSchema) {
        const validationErrors = this.validateArgs(args || {}, toolDetails.inputSchema);
        if (validationErrors.length > 0) {
          throw new Error(
            `Invalid arguments for ${serverName}${toolNameDelimiter}${toolName}: ${validationErrors.join('; ')}`
          );
        }
      }
    } catch (error) {
      // Re-throw validation errors as-is
      if (error instanceof Error && error.message.includes('Invalid arguments')) {
        throw error;
      }
      // If getToolDetails fails (e.g. server disconnected), skip client-side validation
      // and let the MCP server validate — but log at error level since this bypasses our checks
      console.error(`[SKIP VALIDATION] Could not validate args for ${serverName}${toolNameDelimiter}${toolName}:`, error);
    }

    try {
      const result = await client.callTool({
        name: toolName,
        arguments: args
      });

      // Per MCP spec: errors arrive as successful response with isError: true
      // Convert to thrown error so callers can use try/catch (as recommended by MCP best practices)
      if (result && typeof result === 'object' && 'isError' in result && result.isError) {
        let errorMessage = 'Tool execution failed';
        if (result.content && Array.isArray(result.content)) {
          for (const content of result.content) {
            if (content.type === 'text') {
              errorMessage = content.text;
              break;
            }
          }
        }
        throw new Error(`MCP tool error [${serverName}${toolNameDelimiter}${toolName}]: ${errorMessage}`);
      }

      return result;
    } catch (error) {
      // Re-throw MCP errors and our own errors as-is
      if (error instanceof Error) {
        throw error;
      }
      // Wrap unexpected errors
      throw new Error(`Error calling tool ${serverName}${toolNameDelimiter}${toolName}: ${String(error)}`);
    }
  }

  /**
   * Get all tools from all connected servers, formatted for direct loading into the LLM.
   * Only includes servers that are currently connected and enabled.
   * @returns Array of tool definitions ready for OpenAI tools array
   */
  public async getAllToolsForDirectLoading(): Promise<DirectToolDefinition[]> {
    // Return cached result if available (invalidated on tools/list_changed)
    if (this.directLoadingCache !== null) {
      return this.directLoadingCache;
    }

    const allTools: DirectToolDefinition[] = [];

    for (const serverConfig of this.config.servers) {
      if (!serverConfig.enabled) continue;

      try {
        await this.ensureServerConnected(serverConfig.name);

        // Reuse cached tools list (populated by connectServer)
        const cacheKey = `${serverConfig.name}:tools`;
        const cachedEntry = this.toolCache.get(cacheKey);
        if (!cachedEntry) continue;
        const toolsResponse = cachedEntry.data;

        for (const tool of toolsResponse.tools) {
          const fullName = MCPClientManager.getFullToolName(serverConfig.name, tool.name);
          allTools.push({
            type: 'function',
            function: {
              name: fullName,
              description: tool.description || `Tool from ${serverConfig.name}`,
              parameters: (tool.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} }
            }
          });
        }
      } catch (error) {
        console.error(`Error loading tools from server ${serverConfig.name} for direct loading:`, error);
      }
    }

    // Cache the result (invalidated when servers report list_changed)
    this.directLoadingCache = allTools;
    return allTools;
  }

  /**
   * Get tool stubs for sandbox execution.
   * Returns lightweight stubs (full name + server + tool name) without full schemas.
   * Used by SandboxRunner to generate function stubs in the sandbox script.
   * @returns Array of SandboxToolStub objects for available tools
   */
  public async getToolsForSandbox(): Promise<SandboxToolStub[]> {
    const stubs: SandboxToolStub[] = [];

    for (const [serverName, entry] of this.serverRegistry.entries()) {
      const serverConfig = this.config.servers.find(s => s.name === serverName);
      if (!serverConfig?.enabled) continue;

      for (const tool of entry.tools) {
        stubs.push({
          fullName: MCPClientManager.getFullToolName(serverName, tool.name),
          serverName,
          toolName: tool.name,
        });
      }
    }

    // If registry is empty, connect to servers and populate
    if (stubs.length === 0) {
      for (const serverConfig of this.config.servers) {
        if (!serverConfig.enabled) continue;
        try {
          await this.ensureServerConnected(serverConfig.name);
          const entry = this.serverRegistry.get(serverConfig.name);
          if (!entry) continue;
          for (const tool of entry.tools) {
            stubs.push({
              fullName: MCPClientManager.getFullToolName(serverConfig.name, tool.name),
              serverName: serverConfig.name,
              toolName: tool.name,
            });
          }
        } catch (error) {
          console.error(`Error getting sandbox stubs from server ${serverConfig.name}:`, error);
        }
      }
    }

    return stubs;
  }

  /**
   * Get count of all available tools across all enabled servers.
   * Only uses the registry (no new connections). Returns 0 if registry is not yet populated.
   * @returns Total number of tools available from registry
   */
  public getToolCountFromRegistry(): number {
    let count = 0;
    for (const serverConfig of this.config.servers) {
      if (!serverConfig.enabled) continue;
      const registryEntry = this.serverRegistry.get(serverConfig.name);
      if (registryEntry) {
        count += registryEntry.tools.length;
      }
    }
    return count;
  }

  /**
   * Get count of all available tools across all enabled servers (connects on-demand)
   * First tries the registry (no connections), falls back to connecting unregistered servers.
   * @returns Total number of tools available
   */
  public async getToolCount(): Promise<number> {
    // First try registry (no connections needed)
    const registryCount = this.getToolCountFromRegistry();
    if (registryCount > 0) return registryCount;

    // Fallback: connect unregistered servers
    let count = 0;
    for (const serverConfig of this.config.servers) {
      if (!serverConfig.enabled) continue;

      const registryEntry = this.serverRegistry.get(serverConfig.name);
      if (registryEntry) {
        count += registryEntry.tools.length;
        continue;
      }

      try {
        await this.ensureServerConnected(serverConfig.name);
        const entry = this.serverRegistry.get(serverConfig.name);
        if (entry) count += entry.tools.length;
      } catch (error) {
        console.error(`Error counting tools on server ${serverConfig.name}:`, error);
      }
    }

    return count;
  }

  /**
   * Get information about all available servers (connected or not)
   * @returns Array of server info objects
   */
  public async getAvailableServers(): Promise<ServerInfo[]> {
    const servers: ServerInfo[] = [];

    for (const serverConfig of this.config.servers) {
      if (!serverConfig.enabled) continue;

      const isConnected = this.clients.has(serverConfig.name);
      let toolCount = 0;

      // Use registry for tool count (avoids connecting or calling listTools)
      const registryEntry = this.serverRegistry.get(serverConfig.name);
      if (registryEntry) {
        toolCount = registryEntry.tools.length;
      }

      servers.push({
        name: serverConfig.name,
        description: serverConfig.description || registryEntry?.description || `MCP server: ${serverConfig.name} (${serverConfig.type})`,
        connected: isConnected,
        toolCount,
        type: serverConfig.type
      });
    }

    return servers;
  }

  /**
   * Get the full tool name with server prefix using the delimiter
   * Format complies with MCP spec: [a-zA-Z0-9_-]+
   * @param serverName Name of the server
   * @param toolName Name of the tool
   * @returns Full tool name in format "serverName__toolName"
   */
  public static getFullToolName(serverName: string, toolName: string): string {
    return `${serverName}${toolNameDelimiter}${toolName}`;
  }

  /**
   * Parse a full tool name into server name and tool name
   * @param fullToolName Full tool name in format "serverName__toolName"
   * @returns Object with serverName and toolName, or null if parsing fails
   */
  public static parseToolName(fullToolName: string): { serverName: string; toolName: string } | null {
    if (!fullToolName || typeof fullToolName !== 'string') return null;
    const delimiterIndex = fullToolName.indexOf(toolNameDelimiter);
    if (delimiterIndex === -1) return null;
    if (delimiterIndex === 0) return null; // no server name before delimiter
    const serverName = fullToolName.substring(0, delimiterIndex);
    const toolName = fullToolName.substring(delimiterIndex + toolNameDelimiter.length);
    if (!serverName || !toolName) return null;
    return { serverName, toolName };
  }
}