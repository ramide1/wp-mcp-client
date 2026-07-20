# wp-mcp-client

A WhatsApp bot that integrates with Model Context Protocol (MCP) servers, allowing users to interact with various AI-powered tools and services through WhatsApp.

## Features

- WhatsApp integration using whatsapp-web.js
- MCP client support for connecting to local and remote MCP servers
- Environment-based configuration
- Support for both stdio and StreamableHTTP MCP server transports
- Progressive tool discovery with search and inspection capability
- Programmatic tool calling via `execute_tool_sequence` for multi-step operations
- Dynamic server management: on-demand connections with idle timeout (5 min)
- Tool cache with interval-based TTL eviction
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
| `LIMIT_TOKENS_OPENAI` | Maximum tokens for AI responses | `2000` |
| `LIMIT_FETCH` | Number of retry attempts for API calls | `3` |
| `LIMIT_TIME` | Delay between retries in seconds | `5` |
| `LIMIT_TOOLS` | Maximum tool call iterations per message | `10` |
| `LIMIT_HISTORY` | Maximum messages per user in database | `100` |
| `ADMIN_USERS` | Comma-separated list of admin phone numbers | (empty) |
| `BROWSER` | Path to browser executable for Puppeteer | (empty) |
| `TEST_MODE` | Enable test mode (reduces logging) | `false` |
| `INSTRUCTIONS` | Path to custom instructions file | `instructions.txt` |

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
- `type`: Transport type (`stdio` or `sse`)
- `command`: Command to execute (for stdio)
- `args`: Arguments for the command (for stdio)
- `env`: Environment variables (for stdio)
- `url`: Server URL (for sse)
- `enabled`: Whether this server can be connected (servers connect on-demand when tools are needed)

## Usage

1. Start the application:
```bash
bun run src/main.ts
```

2. Scan the QR code displayed in the terminal with your WhatsApp app to link the device.

3. The bot will automatically connect to configured MCP servers and make their tools available for use.

4. Send messages to the bot to interact with AI models and available MCP tools.

## How It Works

When you send a message to the bot:
1. The message is processed along with your conversation history
2. The AI model determines if any available tools (from MCP servers or built-in functions) should be used
3. For MCP tools, the model can:
   - Search for relevant tools using the `search_tools` function
   - Get detailed information about specific tools
   - Execute the tools with appropriate parameters
4. If tools are needed, the bot executes them and incorporates the results
5. The final response is sent back to you via WhatsApp

## Available Built-in Functions

- `clean_current_chat`: Clears the message history for the current user
- `clean_chat` (admin only): Clears message history for a specific user
- `clean_all_chats` (admin only): Clears message history for all users
- `search_tools`: Search for available tools across all connected MCP servers by name/description
- `get_tool_details`: Get full schema and documentation for a specific tool
- `execute_tool_sequence`: Execute a sequence of MCP tool calls efficiently in a single pass, with support for chaining results between steps

## MCP Integration

This implementation follows the Model Context Protocol (MCP) specification and best practices as outlined in the [MCP documentation](https://modelcontextprotocol.io/docs/develop/build-client) and [MCP client best practices](https://modelcontextprotocol.io/docs/develop/clients/client-best-practices):
- Progressive tool discovery with `search_tools` and `get_tool_details` for finding and inspecting tools
- Programmatic tool calling via `execute_tool_sequence` for chaining multiple tool calls without passing intermediate results through the model
- Dynamic server management: servers connected on-demand, disconnected after 5 min idle
- Tool cache with interval-based TTL (5 min) and invalidation on `tools/list_changed` notifications
- Properly handles MCP tool responses including `isError` flags per specification
- Supports both stdio and StreamableHTTP transports

## Requirements

- Bun v1.0+
- WhatsApp account
- OpenAI API key (for AI capabilities)
- Any desired MCP servers (optional, for extended functionality)

## License

MIT