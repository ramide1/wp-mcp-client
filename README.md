# wp-mcp-client

A WhatsApp bot that integrates with Model Context Protocol (MCP) servers, allowing users to interact with various AI-powered tools and services through WhatsApp.

## Features

- WhatsApp integration using whatsapp-web.js
- MCP client support for connecting to local and remote MCP servers
- Environment-based configuration
- Support for both stdio and StreamableHTTP MCP server transports
- Progressive tool discovery with search and inspection capability
- Programmatic tool calling via `execute_tool_sequence` for multi-step operations
- Sandboxed code execution via `execute_code` (isolated Bun subprocess, only output returns to model)
- Dynamic server management: on-demand connections with idle timeout (30 min by default)
- Tool cache with interval-based TTL eviction
- Argument validation against tool schemas (JSON Schema draft-07) before MCP server calls
- Smart result truncation with structural-aware formatting for JSON outputs
- Configurable AI model integration (OpenAI by default)
- Admin controls for privileged users
- Message history persistence (SQLite)

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd wp-mcp-client
```

2. Install dependencies:
```bash
bun install
```

## Configuration

### Environment Variables

Create a `.env` file based on the provided `.env.example`:

```bash
cp .env.example .env
```

Then edit the `.env` file to configure your settings:

| Variable | Description | Default |
|----------|-------------|---------|
| `TOKEN_OPENAI_API` | OpenAI API key for text models | (required) |
| `TOKEN_OPENAI_AUDIO_API` | OpenAI API key for audio models (if different) | `TOKEN_OPENAI_API` |
| `URL_BASE_OPENAI_API` | Base URL for OpenAI API | `https://api.openai.com/v1/chat/completions` |
| `URL_BASE_OPENAI_AUDIO_API` | Base URL for OpenAI audio API | (empty) |
| `MODEL_API_AUDIO_OPENAI` | Model to use for audio transcription | (empty) |
| `MODEL_API_OPENAI` | Model to use for text generation | `gpt-4o` |
| `MODEL_SUPPORTS_IMAGE` | Whether the model supports image input | `false` |
| `AUDIO_LANGUAGE` | Language for audio transcription | `en` |
| `LIMIT_TOKENS_OPENAI` | Maximum tokens for AI responses | `2000` |
| `LIMIT_FETCH` | Number of retry attempts for API calls | `3` |
| `LIMIT_TIME` | Delay between retries in seconds | `5` |
| `LIMIT_TOOLS` | Maximum tool call iterations per message | `10` |
| `LIMIT_HISTORY` | Maximum messages per user in database | `100` |
| `MAX_TOOL_RESULT_LENGTH` | Max characters for tool results sent to the LLM | `8000` |
| `SANDBOX_TIMEOUT` | Timeout in seconds for `execute_code` sandbox | `30` |
| `SANDBOX_NETWORK_ACCESS` | Allow network access in sandbox (false = blocked, true = allowed) | `false` |
| `SANDBOX_ALLOWED_TOOLS` | Comma-separated whitelist of tool names allowed in sandbox (empty = all tools) | (empty) |
| `MAX_CONTEXT_TOKENS` | Max estimated tokens for messages array (truncates oldest messages when exceeded) | `120000` |
| `ADMIN_USERS` | Comma-separated list of admin phone numbers | (empty) |
| `BROWSER` | Path to browser executable for Puppeteer | (empty) |
| `TEST_MODE` | Enable test mode (reduces logging) | `false` |
| `INSTRUCTIONS` | Path to custom instructions file | `instructions.txt` |
| `MCP_TOOL_THRESHOLD` | Max tools before switching to progressive discovery (search meta-tools) | `15` |
| `MCP_STABLE_TOOLS` | Always use `call_tool` wrapper to keep tools array stable for prompt caching | `true` |
| `CACHE_TTL` | Cache TTL in seconds for tool definitions (default: 300 = 5 minutes) | `300` |
| `IDLE_TIMEOUT` | Idle timeout in seconds before disconnecting a server | `1800` (30 min) |
| `TOOL_TIMEOUT` | Timeout in seconds for a single MCP tool call | `60` |
| `SQLITE_DATABASE` | Path to the SQLite history database | `db.sqlite` |
| `SANDBOX_MEMORY_MB` | Max memory (MB) for the sandbox subprocess | `256` |
| `SANDBOX_MAX_TOOL_CALLS` | Max tool calls per sandbox execution | `50` |
| `SANDBOX_MAX_OUTPUT_LENGTH` | Max characters returned from a sandbox run | `10000` |
| `SANDBOX_STEP_TIMEOUT` | Timeout in seconds for each step of `execute_tool_sequence` | `30` |
| `CONFIRM_TOOLS` | Glob patterns of the tools that require the user confirmation (empty = all MCP tools) | (empty) |
| `CONFIRM_TIMEOUT` | Seconds to wait for the answer of the user | `120` |
| `LOG_LEVEL` | Log level (`debug`, `info`, `warn`, `error`) | `info` |
| `LOG_FORMAT` | Log format (`text` or `json`) | `text` |
| `MCP_HEADER_MODE` | SEP-2243 header mirroring (`auto`, `always`, `never`) | `auto` |

> **All the timeouts are configured in seconds** (`LIMIT_TIME`, `SANDBOX_TIMEOUT`, `SANDBOX_STEP_TIMEOUT`, `CACHE_TTL`, `IDLE_TIMEOUT`, `TOOL_TIMEOUT`, `CONFIRM_TIMEOUT`).

### MCP Server Configuration

Configure MCP servers in `mcp-servers.json` (based on `mcp-servers.json.example`):

```json
{
  "servers": [
    {
      "name": "filesystem",
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/files"],
      "env": {},
      "enabled": true
    }
  ]
}
```

Each server object supports:
- `name`: Unique identifier for the server
- `type`: Transport type (`stdio` or `streamable-http`)
- `command`: Command to execute (for stdio)
- `args`: Arguments for the command (for stdio)
- `env`: Environment variables (for stdio)
- `url`: Server URL (for streamable-http)
- `headers`: Static HTTP headers (for streamable-http)
- `oauth`: OAuth 2.1 configuration (for streamable-http), see below
- `enabled`: Whether this server can be connected (servers connect on-demand when tools are needed)

#### OAuth 2.1 for remote servers

Remote servers can authenticate with OAuth 2.1 instead of a static header:

```json
{
  "name": "remote-oauth",
  "type": "streamable-http",
  "url": "https://example.com/mcp",
  "oauth": {
    "grant": "client_credentials",
    "clientId": "YOUR_CLIENT_ID",
    "clientSecret": "YOUR_CLIENT_SECRET",
    "scope": "read write"
  },
  "enabled": true
}
```

- `client_credentials`: machine to machine, no user interaction. The client
  discovers the protected resource metadata (RFC 9728) and the authorization
  server metadata, then exchanges its credentials for an access token.
- `authorization_code`: interactive flow with PKCE. Set `redirectUri` and,
  optionally, `dynamicRegistration: true` to register the client on the fly
  (RFC 7591). The bot logs the authorization URL and reports it when a tool
  call fails; an admin can then finish the flow from WhatsApp with
  `/oauth <serverName> <authorizationCode>`.
- Tokens, client information and the PKCE verifier are persisted in
  `auth/oauth-<server>.json` (gitignored), so a restart does not force a new
  authorization round trip.

#### Tool confirmation (human in the loop)

The bot never executes a protected tool without an explicit approval from the
user. When the model requests one, the bot sends a confirmation message with the
tool name and its arguments and waits for the answer (`CONFIRM_TIMEOUT`
seconds, 120 by default). Only `sí`/`yes` approves the call; `no` cancels it and
an expired request is reported to the model as a failure.

- `CONFIRM_TOOLS`: comma separated glob patterns (`*` and `?`) matched against
  `server__tool` and against the bare tool name. When it is empty (the default)
  every MCP tool call requires confirmation; `CONFIRM_TOOLS=none` disables it.
- The read-only helpers (`search_tools`, `get_tool_details`,
  `search_available_servers`, `list_resources`, `read_resource`, `list_prompts`,
  `get_prompt`) are never confirmed, so the model can still explore the
  catalogue.
- `execute_code` is confirmed when at least one of the available tools requires
  approval, because the generated code is opaque.
- The system prompt tells the model not to ask for confirmation itself: the host
  owns that flow. If your `instructions.txt` asks the model to request the
  confirmation, remove that instruction to avoid asking twice.

## Usage

1. Start the application:
```bash
bun run start
```

2. Scan the QR code displayed in the terminal with your WhatsApp app to link the device.

3. The bot connects to configured MCP servers on-demand when a tool from that server is invoked, and disconnects them after `IDLE_TIMEOUT` seconds of inactivity (30 minutes by default).

4. Send messages to the bot to interact with AI models and available MCP tools.

## How It Works

When you send a message to the bot:
1. The message is processed along with your conversation history
2. **Progressive Discovery**: If total MCP tools <= `MCP_TOOL_THRESHOLD` (default: 15), tools are loaded directly into the LLM context. Otherwise, meta-tools (`search_tools`, `get_tool_details`) are used for on-demand discovery.
3. The AI model determines if any available tools should be used:
   - **Direct mode**: MCP tools are in the tools array, model calls them directly
   - **Discovery mode**: Model uses `search_tools` to find relevant tools, `get_tool_details` to inspect schemas, then `call_tool` to execute
4. For multi-step operations, the model can use:
   - `execute_tool_sequence`: Chain multiple tool calls with result sharing (runs in a sandboxed Bun subprocess)
   - `execute_code`: Write JavaScript that calls tools in a sandboxed subprocess
5. If a tool requires confirmation, the bot asks you to approve it and waits for your answer (the call is not executed until you approve it)
6. If tools are needed, the bot executes them and incorporates the results
7. The final response is sent back to you via WhatsApp

## Available Built-in Functions

- `clean_current_chat`: Clears the message history for the current user
- `clean_chat` (admin only): Clears message history for a specific user
- `clean_all_chats` (admin only): Clears message history for all users
- `search_tools`: Search for available tools across all connected MCP servers by name/description
- `get_tool_details`: Get full schema and documentation for a specific tool
- `call_tool`: Call any MCP tool by server and tool name (used when `MCP_STABLE_TOOLS` is enabled)
- `execute_tool_sequence`: Execute a sequence of MCP tool calls efficiently in a single pass, with support for chaining results between steps
- `execute_code`: Execute JavaScript code in a sandbox with access to MCP tools; only console output returns to the conversation
- `search_available_servers`: List all available MCP servers, their status, and tool counts
- `list_resources`: List the resources exposed by the MCP servers
- `read_resource`: Read the content of a resource by URI
- `list_prompts`: List the prompts exposed by the MCP servers
- `get_prompt`: Get a prompt with its rendered messages and arguments

## MCP Integration

This implementation follows the Model Context Protocol (MCP) specification and best practices as outlined in the [MCP documentation](https://modelcontextprotocol.io/docs/2026-07-28/develop/build-client) and [MCP client best practices](https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices):
- Progressive tool discovery with `search_tools` and `get_tool_details` for finding and inspecting tools
- Programmatic tool calling via `execute_tool_sequence` for chaining multiple tool calls without passing intermediate results through the model (runs in a sandboxed Bun subprocess)
- Sandboxed code execution via `execute_code` runs model-generated JavaScript in an isolated Bun subprocess with MCP tool stubs; only `console.log` output returns to the model
- Sandbox network isolation: direct network access is blocked by default — `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and the `node:net`/`node:http`/`node:https`/`node:tls`/`node:dgram` primitives are disabled. All external communication must go through MCP tool stubs (configurable via `SANDBOX_NETWORK_ACCESS`)
- Sandbox credential isolation: the sandbox subprocess is spawned with a scrubbed environment, so API keys of the host process are not visible to model-generated code
- Sandbox filesystem isolation: `node:fs`, `node:child_process` and the equivalent Bun APIs are disabled, and the subprocess runs in an isolated temporary working directory
- Per-call authorization: sandbox tool calls are validated against a configurable whitelist (`SANDBOX_ALLOWED_TOOLS`); empty whitelist allows all tools (backward compatible)
- Dynamic server management: servers connected on-demand, disconnected after `IDLE_TIMEOUT` (30 min by default); servers whose tools are in the active LLM context stay pinned
- Lightweight server registry: stores tool metadata (name + description) without full connections, enabling fast search without connecting to every server
- Tool cache with interval-based TTL (5 min) and invalidation on `tools/list_changed` notifications
- Argument validation: `callTool()` validates arguments against tool input schemas (JSON Schema draft-07/2020-12 subset, including `$ref`, `anyOf`/`oneOf` and nested objects) before sending to MCP servers
- Result validation: tool results are validated against their `outputSchema` when the server declares one
- Pagination: `tools/list` is read following the pagination cursor, so servers with many tools are fully indexed
- Smart result truncation: `call_tool` uses structural-aware truncation (`truncateResult` in `src/text.ts`) that preserves JSON formatting and provides summaries (e.g. `Array[N items]`, `Object{key1, ...}`). `execute_tool_sequence`'s sandbox uses a simpler fixed-length per-step preview.
- Properly handles MCP tool responses including `isError` flags per specification
- Supports both stdio and StreamableHTTP transports
- OAuth 2.1 for remote servers: `client_credentials` and `authorization_code` (PKCE), with persisted tokens
- Resources and prompts are exposed to the model (`list_resources`, `read_resource`, `list_prompts`, `get_prompt`)
- `tools/list_changed`, `prompts/list_changed` and `resources/list_changed` notifications invalidate the caches and re-index the registry
- SEP-2243 (`x-mcp-header`): the parameters annotated by the server are mirrored into `Mcp-Param-*` HTTP headers; tools with invalid annotations are excluded from the registry
- Tool names follow the SEP-986 charset (`[A-Za-z0-9._-]{1,128}`), so names such as `admin.tools.list` are supported
- Human in the loop: tool calls that require confirmation are not dispatched until the user approves them in the chat, whatever the model does
- Structured logging with secret redaction (`LOG_LEVEL`, `LOG_FORMAT`)

## Development

```bash
bun run test       # unit, integration and end-to-end tests (bun test)
bun run typecheck  # TypeScript type check (no emit)
```

The test suite is split in three layers:

- **Unit tests** (`src/*.test.ts`): pure helpers, JSON Schema validator, sandbox, confirmation manager, SEP-2243 headers, logger, OAuth provider, SQLite history and the tool dispatcher.
- **Integration tests** (`src/mcp.integration.test.ts`): the client is connected to a real MCP server served over Streamable HTTP (`src/test-support/mcp-test-server.ts`), so pagination, resources, prompts, tool errors, `list_changed` notifications and the SEP-2243 header mirroring are exercised against the actual protocol.
- **End-to-end tests** (`src/oauth.e2e.test.ts`): the whole OAuth 2.1 flow (`authorization_code` with PKCE and `client_credentials`) against a mock authorization server (`src/test-support/oauth-test-server.ts`).

`bun run typecheck` pins TypeScript 5.9 because the native TypeScript 7 compiler used by
`bunx tsc --noEmit` needs the platform specific package (`@typescript/typescript-linux-x64`,
`@typescript/typescript-darwin-arm64`, ...) to be installed.

## Requirements

- Bun v1.0+
- WhatsApp account
- OpenAI API key (for AI capabilities)
- Any desired MCP servers (optional, for extended functionality)

## License

MIT