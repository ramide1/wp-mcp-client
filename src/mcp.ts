import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  MCPConfig,
  MCPServerConfig,
  ToolSearchResultDetailed,
  SearchDetailLevel,
  ServerInfo,
  DirectToolDefinition,
  SandboxToolStub,
  McpToolDefinition,
  McpToolResult,
  McpResource,
  McpResourceTemplate,
  McpPrompt
} from './interface';
import { validateArgs as validateSchemaArgs, validateResult as validateSchemaResult } from './schema';
import { timeoutFromEnv } from './env';
import { readFileSync, existsSync } from 'fs';
import { join, isAbsolute } from 'path';
import { createLogger } from './logger';
import { buildParamHeaders, scanHeaderDeclarations, type HeaderDeclaration } from './headers';
import { createOAuthProvider, type McpOAuthProvider } from './oauth';

const log = createLogger('mcp');

// Tool name delimiter: used to separate serverName from toolName in MCP tool names
// Using __ (double underscore) to comply with MCP spec tool name format [a-zA-Z0-9_-]+
// Single _ is also valid but __ makes the boundary clearer
export const toolNameDelimiter = '__';

// MCP tool name format (SEP-986): letters, digits, underscore, dash and dot,
// between 1 and 128 characters. Dot separated names such as "admin.tools.list" are legal.
// https://modelcontextprotocol.io/specification/2026-07-28/server/tools#tool-names
const MCP_TOOL_NAME_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;

// Server names use the same charset, but must not contain the delimiter:
// parseToolName() splits the full name on the FIRST "__".
const MCP_SERVER_NAME_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;

/**
 * The tool does not exist on the server. This is a hard error: the call
 * cannot be performed at all.
 */
export class ToolNotFoundError extends Error {
    constructor(serverName: string, toolName: string) {
        super(`Tool ${toolName} not found on server ${serverName}`);
        this.name = 'ToolNotFoundError';
    }
}

/**
 * The arguments do not satisfy the input schema of the tool. This is a hard
 * error: the call is rejected before it reaches the server.
 */
export class ToolValidationError extends Error {
    constructor(serverName: string, toolName: string, errors: string[]) {
        super(`Invalid arguments for ${serverName}${toolNameDelimiter}${toolName}: ${errors.join('; ')}`);
        this.name = 'ToolValidationError';
    }
}

/**
 * Validate a tool name against the MCP spec format.
 * @param name Tool name to validate
 * @returns true if the name matches [a-zA-Z0-9._-]{1,128}
 */
export const isValidToolName = (name: string): boolean => MCP_TOOL_NAME_REGEX.test(name);

/**
 * Validate a server name: same charset as tool names, but without the delimiter.
 */
export const isValidServerName = (name: string): boolean =>
  MCP_SERVER_NAME_REGEX.test(name) && !name.includes(toolNameDelimiter);

// Data stored in the tool cache: either the full tools list of a server or a
// single tool definition.
type CacheEntryData = { tools: McpToolDefinition[]; serverTtlMs?: number } | McpToolDefinition;

// How the SEP-2243 headers are mirrored into the HTTP requests.
type HeaderMode = 'auto' | 'always' | 'never';

// Maximum number of servers connected on demand when listing resources or prompts.
const MAX_RESOURCE_CONNECTIONS = 5;

export class MCPClientManager {
  private clients: Map<string, Client> = new Map();
  private connectingServers: Map<string, Promise<void>> = new Map(); // Track in-flight connections
  private disconnectingServers: Set<string> = new Set(); // Track in-flight disconnects
  private config: MCPConfig = { servers: [] };
  // LRU tool cache: Map preserves insertion order; on access, entry is moved to end (most recently used).
  // On eviction, entries are removed from the beginning (least recently used).
  // Each entry stores data, timestamp, and optional server-provided TTL (ttlMs from _meta).
  private toolCache: Map<string, { data: CacheEntryData; timestamp: number; serverTtlMs?: number }> = new Map();
  private readonly MAX_CACHE_ENTRIES = 1000; // Max cache entries before LRU eviction
  private configPath: string;
  // Track last used time for each server to implement idle timeout
  private serverLastUsed: Map<string, number> = new Map();
  // ID for the idle cleanup timer
  private idleCleanupTimer: ReturnType<typeof setInterval> | null = null;
  // Guard to prevent overlapping async cleanup runs + promise for in-flight cleanup
  private idleCleanupRunning: boolean = false;
  private idleCleanupPromise: Promise<void> | null = null;
  // Guard to prevent new connections during shutdown
  private isShuttingDown: boolean = false;
  // Idle timeout in milliseconds (configurable via IDLE_TIMEOUT env var, default 30 minutes)
  // Per MCP best practices: "Treat server disconnection as a conversation-boundary operation"
  // 30 minutes preserves prompt cache for typical conversation pauses
  private readonly IDLE_TIMEOUT_MS: number;
  // Servers whose tools are currently loaded in the LLM context (direct loading mode)
  // These servers are "pinned" and won't be disconnected by idle cleanup
  // to preserve prompt cache across conversation pauses
  private activeContextServers: Set<string> = new Set();
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
  // Per-tool call timeout in milliseconds (configurable via TOOL_TIMEOUT env var, default 60 seconds)
  private readonly toolTimeoutMs: number;
  // Servers that failed to connect during this session; skipped by search fallbacks
  private failedServers: Set<string> = new Set<string>();
  // OAuth providers, one per remote server that declares OAuth configuration
  private oauthProviders: Map<string, McpOAuthProvider> = new Map();
  // HTTP transports, kept to be able to finish an OAuth authorization flow
  private transports: Map<string, StreamableHTTPClientTransport> = new Map();
  // Header declarations per server and tool, used to mirror parameters into HTTP headers
  private headerDeclarations: Map<string, Map<string, HeaderDeclaration[]>> = new Map();
  // SEP-2243 header mirroring mode (auto | always | never)
  private readonly headerMode: HeaderMode;

  constructor(configPath: string = './mcp-servers.json') {
    this.configPath = configPath;
    // Every timeout is configured in seconds (see .env.example) and converted
    // to milliseconds here.
    this.CACHE_TTL_MS = timeoutFromEnv('CACHE_TTL', 300);
    this.IDLE_TIMEOUT_MS = timeoutFromEnv('IDLE_TIMEOUT', 30 * 60);
    this.toolTimeoutMs = timeoutFromEnv('TOOL_TIMEOUT', 60);
    const rawHeaderMode = (process.env.MCP_HEADER_MODE ?? 'auto').trim().toLowerCase();
    this.headerMode = (rawHeaderMode === 'always' || rawHeaderMode === 'never') ? rawHeaderMode : 'auto';
    // Cleanup interval: 1/10th of TTL, clamped between 10s and 60s
    this.CLEANUP_INTERVAL_MS = Math.min(Math.max(this.CACHE_TTL_MS / 10, 10_000), 60_000);
    this.loadConfig();
    // Start idle cleanup timer
    this.startIdleCleanup();
  }

  /** Build the cache key for a server's full tools list. */
  private cacheKeyTools(serverName: string): string {
    return `${serverName}:tools`;
  }

  /** Build the cache key for a specific tool's details. */
  private cacheKeyToolDetail(serverName: string, toolName: string): string {
    return `${serverName}:tool:${toolName}`;
  }

  /**
   * Return the cached tools list of a server.
   * Returns undefined when the entry is missing (never cached or expired).
   */
  private getCachedToolsList(serverName: string): { tools: McpToolDefinition[]; serverTtlMs?: number } | undefined {
    const entry = this.toolCache.get(this.cacheKeyTools(serverName));
    if (!entry) return undefined;
    return entry.data as { tools: McpToolDefinition[]; serverTtlMs?: number };
  }

  /**
   * Populate (or refresh) the lightweight server registry and the full tools-list cache
   * for a single connected server. Shared by connectServer and refreshServerRegistry.
   * @param serverName Name of the (already-connected) server
   * @param client Connected MCP Client for the server
   * @param fallbackDescription Description to use if no prior registry entry exists
   */
  private async populateServerRegistry(
    serverName: string,
    client: Client,
    fallbackDescription: string,
    transportType: MCPServerConfig['type'] = 'stdio'
  ): Promise<void> {
    const toolsResponse = await this.listAllTools(client);
    const validToolSummaries: Array<{ name: string; description: string }> = [];
    const invalidToolNames: string[] = [];
    const rejectedByHeaders: string[] = [];
    const rejectedToolNames = new Set<string>();
    const declarations = new Map<string, HeaderDeclaration[]>();

    for (const tool of toolsResponse.tools) {
      if (!isValidToolName(tool.name)) {
        invalidToolNames.push(tool.name);
        continue;
      }

      // SEP-2243: on Streamable HTTP a tool whose x-mcp-header annotations are
      // invalid must be excluded from tools/list.
      if (transportType === 'streamable-http') {
        const scan = scanHeaderDeclarations(tool.inputSchema);
        if (scan.errors.length > 0) {
          rejectedByHeaders.push(`${tool.name} (${scan.errors.join('; ')})`);
          rejectedToolNames.add(tool.name);
          continue;
        }
        if (scan.declarations.length > 0) {
          declarations.set(tool.name, scan.declarations);
        }
      }

      validToolSummaries.push({
        name: tool.name,
        description: tool.description || ''
      });
    }

    if (invalidToolNames.length > 0) {
      log.warn('Server exposes tools with invalid names; they are excluded from the registry', {
        server: serverName,
        expected: '[a-zA-Z0-9._-]{1,128}',
        tools: invalidToolNames.join(', ')
      });
    }

    if (rejectedByHeaders.length > 0) {
      log.warn('Server exposes tools with invalid x-mcp-header annotations; they are excluded', {
        server: serverName,
        tools: rejectedByHeaders.join(' | ')
      });
    }

    // Preserve a prior description if one already exists in the registry
    const existingDescription = this.serverRegistry.get(serverName)?.description;
    this.serverRegistry.set(serverName, {
      description: existingDescription || fallbackDescription,
      tools: validToolSummaries
    });

    // Cache the full tools list for other consumers (getToolDetails, getAllToolsForDirectLoading, etc.)
    const validTools = toolsResponse.tools.filter(
      (tool: McpToolDefinition) => isValidToolName(tool.name) && !rejectedToolNames.has(tool.name)
    );
    this.toolCache.set(this.cacheKeyTools(serverName), {
      data: { tools: validTools, serverTtlMs: toolsResponse.serverTtlMs },
      timestamp: Date.now(),
      serverTtlMs: toolsResponse.serverTtlMs
    });

    // Header declarations are only needed for Streamable HTTP servers
    if (transportType === 'streamable-http') {
      this.headerDeclarations.set(serverName, declarations);
    }
  }

  /**
   * List every tool of a server, following the pagination cursor.
   * The MCP SDK does not paginate automatically, so servers with many tools would
   * otherwise expose only the first page.
   */
  public async listAllTools(client: Client): Promise<{ tools: McpToolDefinition[]; serverTtlMs?: number }> {
    const tools: McpToolDefinition[] = [];
    let serverTtlMs: number | undefined;
    let cursor: string | undefined;
    let pages = 0;

    do {
      const response = await client.listTools(cursor ? { cursor } : {}) as {
        tools?: McpToolDefinition[];
        nextCursor?: string;
        ttlMs?: number;
        _meta?: { ttlMs?: number };
      };
      tools.push(...(response?.tools ?? []));
      // 2026-07-28 spec exposes ttlMs/cacheScope on the result; older servers use _meta
      const ttl = response?.ttlMs ?? response?._meta?.ttlMs;
      if (typeof ttl === 'number') serverTtlMs = ttl;
      cursor = response?.nextCursor;
      pages++;
      if (pages > 50) {
        log.warn('Stopping pagination after 50 pages', { tools: tools.length });
        break;
      }
    } while (cursor);

    return { tools, serverTtlMs };
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
   * Respects server-provided ttlMs from _meta when available; falls back to CACHE_TTL_MS.
   */
  private evictExpiredCache(): void {
    const now = Date.now();
    let evictedCount = 0;

    // Phase 1: Evict entries that exceeded the TTL (iterate oldest first)
    // Use server-provided ttlMs if available, otherwise use default CACHE_TTL_MS
    const expiredKeys: string[] = [];
    for (const [key, entry] of this.toolCache.entries()) {
      const effectiveTtl = entry.serverTtlMs ?? this.CACHE_TTL_MS;
      if (now - entry.timestamp > effectiveTtl) {
        expiredKeys.push(key);
      }
    }

    for (const key of expiredKeys) {
      this.toolCache.delete(key);
    }
    evictedCount += expiredKeys.length;

    // The direct loading cache mirrors the tool definitions of the servers:
    // it must never outlive the definitions it was built from.
    if (expiredKeys.length > 0) {
      this.directLoadingCache = null;
    }

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
      log.debug('Evicted expired cache entries', { count: evictedCount });
    }
  }

  /**
   * Mark servers as being part of the active LLM context.
   * Pinned servers won't be disconnected by idle cleanup to preserve prompt cache.
   * Per MCP best practices: "Treat server disconnection as a conversation-boundary operation"
   * @param serverNames Set of server names currently in the LLM context
   */
  public setActiveContextServers(serverNames: Set<string>): void {
    this.activeContextServers = new Set(serverNames);
  }

  /**
   * Disconnect servers that have been idle for too long.
   * Skips servers that are pinned (in active LLM context) to preserve prompt cache.
   */
  private async disconnectIdleServers(): Promise<void> {
    // Prevent overlapping cleanup runs (async interval protection)
    if (this.idleCleanupRunning) return;
    this.idleCleanupRunning = true;

    const cleanup = (async () => {
      try {
        const now = Date.now();
        const serversToDisconnect: string[] = [];

        for (const [serverName, lastUsed] of this.serverLastUsed.entries()) {
          // Skip if server is not currently connected
          if (!this.clients.has(serverName)) continue;

          // Skip if already being disconnected
          if (this.disconnectingServers.has(serverName)) continue;

          // Skip servers pinned in active LLM context (preserve prompt cache)
          if (this.activeContextServers.has(serverName)) continue;

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
            log.info('Disconnected idle MCP server', { server: serverName });
          } catch (error) {
            log.error('Error disconnecting idle MCP server', { server: serverName, error });
          } finally {
            this.disconnectingServers.delete(serverName);
          }
        }
      } finally {
        this.idleCleanupRunning = false;
        this.idleCleanupPromise = null;
      }
    })();

    this.idleCleanupPromise = cleanup;
    return cleanup;
  }

  /**
   * Disconnect a specific server and clean up its resources.
   * Also cancels any in-flight connection for this server to prevent stale
   * promises from racing with the disconnect.
   */
  private async disconnectServer(serverName: string): Promise<void> {
    // Cancel any in-flight connection attempt for this server.
    // Without this, a reconnect promise can resolve after the disconnect,
    // re-inserting the client into `clients` and causing a race condition.
    const inFlightConnect = this.connectingServers.get(serverName);
    if (inFlightConnect) {
      // Wait for it to settle so we don't close a client mid-connect
      await inFlightConnect.catch(() => {});
      this.connectingServers.delete(serverName);
    }

    const client = this.clients.get(serverName);
    if (client) {
      try {
        await client.close();
        log.info('Disconnected from MCP server', { server: serverName });
      } catch (error) {
        log.error('Error disconnecting from MCP server', { server: serverName, error });
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
      await this.populateServerRegistry(
        serverName,
        client,
        `MCP server: ${serverName}`
      );
      const toolSummaries = this.serverRegistry.get(serverName)?.tools ?? [];
      log.info('Re-indexed registry', { server: serverName, tools: toolSummaries.length });
    } catch (error) {
      log.error('Error re-indexing registry', { server: serverName, error });
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
      log.debug('Invalidated cache entries', { server: serverName, count: keysToDelete.length });
    }
  }

  private loadConfig(): void {
    try {
      // Relative paths are resolved from the working directory; absolute paths are used as is
      const fullPath = isAbsolute(this.configPath) ? this.configPath : join(process.cwd(), this.configPath);
      if (existsSync(fullPath)) {
        const configData = readFileSync(fullPath, 'utf8');
        this.config = JSON.parse(configData);
        log.info('Loaded MCP configuration', { path: fullPath });
      } else {
        log.warn('MCP config file not found, using empty config', { path: fullPath });
        this.config = { servers: [] };
      }
    } catch (error) {
      log.error('Failed to load MCP configuration', { error });
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
    this.activeContextServers.clear();

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
        // Handle list_changed notifications from the server.
        // Invalidates the cache and re-indexes the registry when a list changes.
        // autoRefresh: false because we handle the refresh manually in onChanged
        // to avoid double listTools() calls (SDK default autoRefresh would also call listTools)
        listChanged: {
          tools: {
            autoRefresh: false,
            onChanged: (error) => {
              if (error) {
                log.error('Error receiving tools/list_changed', { server: serverConfig.name, error });
                return;
              }
              log.info('Tools list changed, refreshing cache', { server: serverConfig.name });
              this.invalidateServerCache(serverConfig.name);
              this.refreshServerRegistry(serverConfig.name).catch((err) => {
                log.error('Failed to re-index registry', { server: serverConfig.name, error: err });
              });
            }
          },
          prompts: {
            autoRefresh: false,
            onChanged: (error) => {
              if (error) {
                log.error('Error receiving prompts/list_changed', { server: serverConfig.name, error });
                return;
              }
              log.info('Prompts list changed', { server: serverConfig.name });
              this.invalidateServerCache(serverConfig.name);
            }
          },
          resources: {
            autoRefresh: false,
            onChanged: (error) => {
              if (error) {
                log.error('Error receiving resources/list_changed', { server: serverConfig.name, error });
                return;
              }
              log.info('Resources list changed', { server: serverConfig.name });
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
    } else if (serverConfig.type === 'streamable-http') {
      if (!serverConfig.url) {
        throw new Error(`URL is required for streamable-http server ${serverConfig.name}`);
      }

      // StreamableHTTPClientTransport is the modern transport that supports both HTTP and SSE internally
      const authProvider = this.getOrCreateOAuthProvider(serverConfig);
      const httpTransport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
        ...(serverConfig.headers ? {
          requestInit: {
            headers: serverConfig.headers
          }
        } : {}),
        ...(authProvider ? { authProvider } : {}),
        fetch: this.createHeaderAwareFetch(serverConfig.name)
      });
      this.transports.set(serverConfig.name, httpTransport);
      transport = httpTransport;
    } else {
      throw new Error(`Unsupported server type: ${serverConfig.type}`);
    }

    try {
      await client.connect(transport);
    } catch (error) {
      const provider = this.oauthProviders.get(serverConfig.name);
      if (provider?.authorizationUrl) {
        throw new Error(
          `MCP server "${serverConfig.name}" requires OAuth authorization. ` +
          `Open this URL to authorize and then call completeAuthorization("${serverConfig.name}", "<code>"): ` +
          provider.authorizationUrl
        );
      }
      throw error;
    }
    this.clients.set(serverConfig.name, client);

    // Populate lightweight registry with tool metadata (no full schema)
    try {
      await this.populateServerRegistry(
        serverConfig.name,
        client,
        serverConfig.description || `MCP server: ${serverConfig.name} (${serverConfig.type})`,
        serverConfig.type
      );
    } catch (error) {
      log.error('Error populating registry', { server: serverConfig.name, error });
    }
  }

  /**
   * Build (and cache) the OAuth provider of a remote server.
   */
  private getOrCreateOAuthProvider(serverConfig: MCPServerConfig): McpOAuthProvider | undefined {
    const oauthConfig = serverConfig.oauth;
    if (!oauthConfig) return undefined;

    const existing = this.oauthProviders.get(serverConfig.name);
    if (existing) return existing;

    const provider = createOAuthProvider({
      ...oauthConfig,
      serverName: serverConfig.name,
      serverUrl: serverConfig.url ?? '',
      onAuthorizationRequired: (url) => {
        log.warn('OAuth authorization required for MCP server', { server: serverConfig.name, url });
      }
    });

    if (provider) {
      this.oauthProviders.set(serverConfig.name, provider);
    }
    return provider;
  }

  /**
   * URL that the user has to open to authorize the client, when an
   * interactive OAuth flow is pending.
   */
  public getAuthorizationUrl(serverName: string): string | undefined {
    return this.oauthProviders.get(serverName)?.authorizationUrl;
  }

  /**
   * Finish an interactive OAuth authorization flow.
   * @param serverName Name of the remote server
   * @param authorizationCode Code obtained from the authorization server
   */
  public async completeAuthorization(serverName: string, authorizationCode: string): Promise<void> {
    const transport = this.transports.get(serverName);
    if (!transport) {
      throw new Error(`No HTTP transport found for MCP server ${serverName}`);
    }
    await transport.finishAuth(authorizationCode);
    // The server must be searchable again after a failed authorization attempt
    this.failedServers.delete(serverName);
    log.info('OAuth authorization completed', { server: serverName });
  }

  /**
   * Build a fetch wrapper that mirrors tool parameters into HTTP headers (SEP-2243).
   * The headers are derived from the request body, so they always match it.
   */
  private createHeaderAwareFetch(serverName: string): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      try {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'POST' && typeof init?.body === 'string') {
          const message = JSON.parse(init.body) as { method?: string; params?: Record<string, unknown> };
          const extraHeaders = await this.buildRequestHeaders(serverName, message);
          if (Object.keys(extraHeaders).length > 0) {
            const headers = new Headers(init.headers);
            for (const [key, value] of Object.entries(extraHeaders)) {
              headers.set(key, value);
            }
            init = { ...init, headers };
          }
        }
      } catch (error) {
        // Header mirroring must never break the request itself.
        log.debug('Could not mirror parameters into HTTP headers', {
          server: serverName,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return fetch(input, init);
    }) as typeof fetch;
  }

  /**
   * Compute the extra HTTP headers of a JSON-RPC request.
   *
   * - `Mcp-Param-{Name}` headers mirror the parameters annotated with `x-mcp-header`.
   * - `Mcp-Method` and `Mcp-Name` are the standard headers of SEP-2243; they are
   *   only sent in `always` mode because they are mandatory from protocol 2026-07-28.
   */
  private async buildRequestHeaders(
    serverName: string,
    message: { method?: string; params?: Record<string, unknown> }
  ): Promise<Record<string, string>> {
    if (this.headerMode === 'never') return {};
    const method = message.method;
    if (!method) return {};

    const headers: Record<string, string> = {};

    if (this.headerMode === 'always') {
      // Mcp-Method is required for every request and notification
      headers['Mcp-Method'] = method;
      // Mcp-Name is only defined for tools/call, resources/read and prompts/get
      if (method === 'tools/call' || method === 'resources/read' || method === 'prompts/get') {
        const name = message.params?.name;
        const uri = message.params?.uri;
        if (typeof name === 'string' && name.length > 0) headers['Mcp-Name'] = name;
        else if (typeof uri === 'string' && uri.length > 0) headers['Mcp-Name'] = uri;
      }
    }

    if (method === 'tools/call') {
      const toolName = message.params?.name;
      if (typeof toolName !== 'string') return headers;
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;

      let declarations = this.headerDeclarations.get(serverName)?.get(toolName);
      if (!declarations) {
        // The schema may not be indexed yet: fetch it to build the headers.
        try {
          const details = await this.getToolDetails(serverName, toolName);
          const scan = scanHeaderDeclarations(details?.inputSchema);
          declarations = scan.declarations;
          if (declarations.length > 0) {
            const perServer = this.headerDeclarations.get(serverName) ?? new Map<string, HeaderDeclaration[]>();
            perServer.set(toolName, declarations);
            this.headerDeclarations.set(serverName, perServer);
          }
        } catch {
          // Without a schema the request is sent without the mirrored headers.
          return headers;
        }
      }

      Object.assign(headers, buildParamHeaders(declarations, args));
    }

    return headers;
  }

  public async disconnectAll(): Promise<void> {
    // Set shutdown flag first to prevent any new connections
    this.isShuttingDown = true;

    // Clear idle cleanup timer
    if (this.idleCleanupTimer) {
      clearInterval(this.idleCleanupTimer);
      this.idleCleanupTimer = null;
    }

    // Wait for any in-flight idle cleanup to finish before closing clients.
    // Without this, a disconnectIdleServers() running in the background could
    // still call disconnectServer() after disconnectAll() has closed clients,
    // causing errors or partially-cleaned state.
    if (this.idleCleanupPromise) {
      await this.idleCleanupPromise.catch(() => {});
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
        log.info('Disconnected from MCP server', { server: name });
      } catch (error) {
        log.error('Error disconnecting from MCP server', { server: name, error });
      }
    }
    this.clients.clear();
    this.serverLastUsed.clear();
    this.activeContextServers.clear();
    // Registry persists for fast searches without reconnecting

    // Reset shutdown flag so the manager can be reused if needed
    this.isShuttingDown = false;
  }

  private getClient(serverName: string): Client | undefined {
    if (this.isShuttingDown) return undefined;
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
  private async ensureServerConnected(serverName: string): Promise<void> {
    if (!serverName || typeof serverName !== 'string') {
      throw new Error('Invalid server name');
    }
    if (!isValidServerName(serverName)) {
      throw new Error(
        `Invalid server name format: ${serverName}. ` +
        `It must match [a-zA-Z0-9._-]{1,128} and must not contain "${toolNameDelimiter}".`
      );
    }

    if (this.isShuttingDown) {
      throw new Error(`Cannot connect to server ${serverName}: shutting down`);
    }

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
    const buildResult = (
      serverName: string,
      tool: { name: string; description: string },
      fullTool?: McpToolDefinition
    ): ToolSearchResultDetailed => {
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
          let fullTool: McpToolDefinition | undefined = undefined;
          if (detailLevel === 'full') {
            // Get full tool from cache if available
            const cached = this.toolCache.get(this.cacheKeyTools(serverName));
            const cachedTools = (cached?.data as { tools?: McpToolDefinition[] } | undefined)?.tools;
            fullTool = cachedTools?.find(t => t.name === tool.name);
          }
          results.push({ ...buildResult(serverName, tool, fullTool), score });
        }
      }
      if (results.length >= limit * 2) break; // Get extra for sorting
    }

    // Phase 2: Connect to unregistered servers only if results are insufficient.
    // Prioritize servers by description relevance to the query before connecting.
    // Limit connection attempts to avoid connecting to every server on each search.
    const MAX_PHASE2_ATTEMPTS = 5;
    let phase2Attempts = 0;
    if (results.length < limit) {
      // Score unregistered servers by description relevance to prioritize connections
      const unregisteredServers: Array<{ config: MCPServerConfig; descScore: number }> = [];
      for (const serverConfig of this.config.servers) {
        if (this.isShuttingDown) break;
        if (!serverConfig.enabled) continue;
        if (this.serverRegistry.has(serverConfig.name)) continue;
        // Skip servers that already failed to connect in this session
        if (this.failedServers.has(serverConfig.name)) continue;

        // Score server description against the query (reuse the same scoring logic)
        const desc = serverConfig.description || '';
        const descScore = scoreTool(serverConfig.name, desc);
        unregisteredServers.push({ config: serverConfig, descScore });
      }
      // Sort by description relevance (most relevant first)
      unregisteredServers.sort((a, b) => b.descScore - a.descScore);

      for (const { config: serverConfig } of unregisteredServers) {
        if (phase2Attempts >= MAX_PHASE2_ATTEMPTS) break;
        if (results.length >= limit * 2) break;

        phase2Attempts++;
        try {
          await this.ensureServerConnected(serverConfig.name);
          const entry = this.serverRegistry.get(serverConfig.name);
          if (!entry) continue;

          for (const tool of entry.tools) {
            const score = scoreTool(tool.name, tool.description);
            if (score > 0) {
              let fullTool: McpToolDefinition | undefined = undefined;
              if (detailLevel === 'full') {
                const cached = this.toolCache.get(this.cacheKeyTools(serverConfig.name));
                const cachedTools = (cached?.data as { tools?: McpToolDefinition[] } | undefined)?.tools;
                fullTool = cachedTools?.find(t => t.name === tool.name);
              }
              results.push({ ...buildResult(serverConfig.name, tool, fullTool), score });
            }
          }
        } catch (error) {
          this.failedServers.add(serverConfig.name);
          log.error('Error searching tools on server', { server: serverConfig.name, error });
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
  public async getToolDetails(serverName: string, toolName: string): Promise<McpToolDefinition> {
    await this.ensureServerConnected(serverName);

    // Check tool-specific cache first
    const detailCacheKey = this.cacheKeyToolDetail(serverName, toolName);
    const cachedDetail = this.toolCache.get(detailCacheKey);
    if (cachedDetail !== undefined) {
      this.touchCache(detailCacheKey);
      return cachedDetail.data as McpToolDefinition;
    }

    // Reuse the cached tools list instead of calling listTools() again
    const listCacheKey = this.cacheKeyTools(serverName);
    let toolsResponse: { tools: McpToolDefinition[]; serverTtlMs?: number };
    const cachedEntry = this.toolCache.get(listCacheKey);
    if (cachedEntry !== undefined) {
      toolsResponse = cachedEntry.data as { tools: McpToolDefinition[]; serverTtlMs?: number };
      this.touchCache(listCacheKey);
    } else {
      const client = this.getClient(serverName);
      if (!client) {
        throw new Error(`MCP client for server ${serverName} not found`);
      }
      toolsResponse = await this.listAllTools(client);
      this.toolCache.set(listCacheKey, { data: toolsResponse, timestamp: Date.now(), serverTtlMs: toolsResponse.serverTtlMs });
    }

    const tool = toolsResponse.tools.find(t => t.name === toolName);
    if (!tool) {
      throw new ToolNotFoundError(serverName, toolName);
    }

    // Cache the tool details (evicted by LRU)
    this.toolCache.set(detailCacheKey, { data: tool, timestamp: Date.now() });
    return tool;
  }

  /**
   * Validate tool arguments against its input schema (JSON Schema draft-07).
   * Returns an array of validation error messages. Empty array means valid.
   */
  private validateArgs(args: Record<string, unknown>, schema: unknown): string[] {
    return validateSchemaArgs(args, schema);
  }

  /**
   * Resolve the servers to query for resources or prompts.
   * With a server name only that server is used (connecting it if needed).
   * Without one, every enabled server is considered, connecting at most
   * MAX_RESOURCE_CONNECTIONS new servers.
   */
  private async resolveServers(serverName?: string): Promise<string[]> {
    if (serverName) {
      await this.ensureServerConnected(serverName);
      return [serverName];
    }

    const names: string[] = [];
    let pendingConnections = 0;
    for (const serverConfig of this.config.servers) {
      if (!serverConfig.enabled) continue;
      if (this.failedServers.has(serverConfig.name)) continue;
      if (!this.clients.has(serverConfig.name)) {
        if (pendingConnections >= MAX_RESOURCE_CONNECTIONS) continue;
        pendingConnections++;
      }
      names.push(serverConfig.name);
    }
    return names;
  }

  /**
   * List the resources exposed by one or every enabled MCP server.
   */
  public async listResources(serverName?: string): Promise<Array<McpResource & { serverName: string }>> {
    const results: Array<McpResource & { serverName: string }> = [];
    const servers = await this.resolveServers(serverName);

    for (const name of servers) {
      try {
        await this.ensureServerConnected(name);
        const client = this.getClient(name);
        if (!client) continue;
        const response = await client.listResources();
        for (const resource of response.resources ?? []) {
          results.push({ ...resource, serverName: name });
        }
      } catch (error) {
        log.debug('Server does not expose resources', {
          server: name,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return results;
  }

  /**
   * List the resource templates exposed by one or every enabled MCP server.
   */
  public async listResourceTemplates(serverName?: string): Promise<Array<McpResourceTemplate & { serverName: string }>> {
    const results: Array<McpResourceTemplate & { serverName: string }> = [];
    const servers = await this.resolveServers(serverName);

    for (const name of servers) {
      try {
        await this.ensureServerConnected(name);
        const client = this.getClient(name);
        if (!client) continue;
        const response = await client.listResourceTemplates();
        for (const template of response.resourceTemplates ?? []) {
          results.push({ ...template, serverName: name });
        }
      } catch (error) {
        log.debug('Server does not expose resource templates', {
          server: name,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return results;
  }

  /**
   * Read a resource by URI.
   */
  public async readResource(serverName: string, uri: string): Promise<unknown> {
    await this.ensureServerConnected(serverName);
    const client = this.getClient(serverName);
    if (!client) {
      throw new Error(`MCP client for server ${serverName} not found`);
    }
    return await client.readResource({ uri });
  }

  /**
   * List the prompts exposed by one or every enabled MCP server.
   */
  public async listPrompts(serverName?: string): Promise<Array<McpPrompt & { serverName: string }>> {
    const results: Array<McpPrompt & { serverName: string }> = [];
    const servers = await this.resolveServers(serverName);

    for (const name of servers) {
      try {
        await this.ensureServerConnected(name);
        const client = this.getClient(name);
        if (!client) continue;
        const response = await client.listPrompts();
        for (const prompt of response.prompts ?? []) {
          results.push({ ...prompt, serverName: name });
        }
      } catch (error) {
        log.debug('Server does not expose prompts', {
          server: name,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return results;
  }

  /**
   * Get a prompt definition with its rendered messages.
   */
  public async getPrompt(
    serverName: string,
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<unknown> {
    await this.ensureServerConnected(serverName);
    const client = this.getClient(serverName);
    if (!client) {
      throw new Error(`MCP client for server ${serverName} not found`);
    }
    // The MCP protocol only allows string arguments in a prompt.
    const stringArgs: Record<string, string> = {};
    for (const [key, value] of Object.entries(args)) {
      stringArgs[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
    return await client.getPrompt({ name, arguments: stringArgs });
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
  public async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    await this.ensureServerConnected(serverName);
    const client = this.getClient(serverName);
    if (!client) {
      throw new Error(`MCP client for server ${serverName} not found`);
    }

    // Validate args against tool's input schema before sending to server
    let toolOutputSchema: Record<string, unknown> | undefined = undefined;
    try {
      const toolDetails = await this.getToolDetails(serverName, toolName);
      if (toolDetails?.inputSchema) {
        const validationErrors = this.validateArgs(args || {}, toolDetails.inputSchema);
        if (validationErrors.length > 0) {
          throw new ToolValidationError(serverName, toolName, validationErrors);
        }
      }
      toolOutputSchema = toolDetails?.outputSchema;
    } catch (error) {
      // Unknown tools and invalid arguments are real errors, not a reason to skip validation
      if (error instanceof ToolNotFoundError || error instanceof ToolValidationError) {
        throw error;
      }
      // If getToolDetails fails (e.g. server disconnected), skip client-side validation
      // and let the MCP server validate — but log at error level since this bypasses our checks
      log.error('[SKIP VALIDATION] Could not validate arguments', {
        server: serverName,
        tool: toolName,
        error
      });
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const callPromise = client.callTool({
        name: toolName,
        arguments: args
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`Tool call timed out after ${this.toolTimeoutMs / 1000}s`)), this.toolTimeoutMs);
      });

      const result = await Promise.race([callPromise, timeoutPromise]) as McpToolResult;

      // Per MCP spec: errors arrive as successful response with isError: true
      // Convert to thrown error so callers can use try/catch (as recommended by MCP best practices)
      if (result && typeof result === 'object' && 'isError' in result && result.isError) {
        let errorMessage = 'Tool execution failed';
        if (result.content && Array.isArray(result.content)) {
          for (const content of result.content) {
            if (content.type === 'text' && typeof content.text === 'string') {
              errorMessage = content.text;
              break;
            }
          }
        }
        throw new Error(`MCP tool error [${serverName}${toolNameDelimiter}${toolName}]: ${errorMessage}`);
      }

      // Validate the result against the tool's outputSchema (spec: clients SHOULD validate).
      // A mismatch is reported but does not fail the call: the server already executed the tool.
      if (toolOutputSchema) {
        const resultErrors = validateSchemaResult(result, toolOutputSchema);
        if (resultErrors.length > 0) {
          log.warn('Result does not match the outputSchema of the tool', {
            server: serverName,
            tool: toolName,
            errors: resultErrors.join('; ')
          });
        }
      }

      return result;
    } catch (error) {
      // Re-throw MCP errors and our own errors as-is
      if (error instanceof Error) {
        throw error;
      }
      // Wrap unexpected errors
      throw new Error(`Error calling tool ${serverName}${toolNameDelimiter}${toolName}: ${String(error)}`);
    } finally {
      // The timeout timer must not outlive the call it was guarding.
      if (timeoutHandle) clearTimeout(timeoutHandle);
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

        // Reuse the cached tools list (populated by connectServer).
        // When the cache entry expired, list the tools again instead of
        // silently dropping the whole server from the LLM context.
        let toolsResponse = this.getCachedToolsList(serverConfig.name);
        if (!toolsResponse) {
          const client = this.getClient(serverConfig.name);
          if (!client) continue;
          toolsResponse = await this.listAllTools(client);
          this.toolCache.set(this.cacheKeyTools(serverConfig.name), {
            data: toolsResponse,
            timestamp: Date.now(),
            serverTtlMs: toolsResponse.serverTtlMs
          });
        }

        // Sort tools within this server block for deterministic ordering.
        // This ensures the position of tools from OTHER servers is never affected,
        // preserving prompt cache across server tool list changes.
        const serverTools: DirectToolDefinition[] = toolsResponse.tools.map((tool: McpToolDefinition) => ({
          type: 'function' as const,
          function: {
            name: MCPClientManager.getFullToolName(serverConfig.name, tool.name),
            description: tool.description || `Tool from ${serverConfig.name}`,
            parameters: (tool.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
            ...(tool.outputSchema ? { outputSchema: tool.outputSchema as Record<string, unknown> } : {})
          }
        }));
        serverTools.sort((a, b) => a.function.name.localeCompare(b.function.name));
        allTools.push(...serverTools);
      } catch (error) {
        log.error('Error loading tools for direct loading', { server: serverConfig.name, error });
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
          log.error('Error getting sandbox stubs', { server: serverConfig.name, error });
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
  private getToolCountFromRegistry(): number {
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

    // Fallback: connect unregistered servers (registry is empty)
    let count = 0;
    for (const serverConfig of this.config.servers) {
      if (!serverConfig.enabled) continue;

      try {
        await this.ensureServerConnected(serverConfig.name);
        const entry = this.serverRegistry.get(serverConfig.name);
        if (entry) count += entry.tools.length;
      } catch (error) {
        log.error('Error counting tools on server', { server: serverConfig.name, error });
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
      let toolCount: number | null = null;

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
   * Sanitize a tool name to comply with MCP spec format [a-zA-Z0-9_-]+.
   * Replaces invalid characters with underscores.
   * @param name Tool name to sanitize
   * @returns Sanitized tool name
   */
  public static sanitizeToolName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_');
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
   * @returns Object with serverName and toolName, or null if parsing fails or names are invalid
   */
  public static parseToolName(fullToolName: string): { serverName: string; toolName: string } | null {
    if (!fullToolName || typeof fullToolName !== 'string') return null;
    const delimiterIndex = fullToolName.indexOf(toolNameDelimiter);
    if (delimiterIndex === -1) return null;
    if (delimiterIndex === 0) return null; // no server name before delimiter
    const serverName = fullToolName.substring(0, delimiterIndex);
    const toolName = fullToolName.substring(delimiterIndex + toolNameDelimiter.length);
    if (!serverName || !toolName) return null;
    // Validate both parts comply with MCP spec format
    if (!isValidToolName(serverName) || !isValidToolName(toolName)) return null;
    return { serverName, toolName };
  }
}