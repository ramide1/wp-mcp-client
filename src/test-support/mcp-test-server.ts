/**
 * Test helpers: a real MCP server served over Streamable HTTP.
 *
 * It is used by the integration tests to exercise the client against the
 * actual protocol (JSON-RPC over HTTP) instead of a mock.
 */

import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

/** A request received by the test server. */
export interface RecordedRequest {
    /** JSON-RPC method of the request (or the HTTP verb for the non JSON-RPC calls). */
    method: string;
    /** Lowercased headers of the request. */
    headers: Record<string, string>;
    /** Parsed body of the request, when there is one. */
    body?: any;
}

export interface TestMcpServer {
    /** URL of the MCP endpoint. */
    url: string;
    /** Every request received by the server. */
    requests: RecordedRequest[];
    /** Notify the client that the list of tools changed. */
    notifyToolsChanged: () => Promise<void>;
    /** Add a tool to the server and announce the change to the clients. */
    addTool: (tool: Record<string, unknown>) => Promise<void>;
    /** Stop the server and release the port. */
    stop: () => Promise<void>;
}

export interface TestMcpServerOptions {
    /** Token required by the server. When set, the server answers 401 without it. */
    requiredToken?: string;
    /** Extra tools exposed by the server. */
    extraTools?: Array<Record<string, unknown>>;
}

/** Mutable state shared by every session of the test server. */
interface ServerState {
    tools: Array<Record<string, unknown>>;
}

/**
 * Build an MCP server exposing:
 * - `alpha` and `beta`: first page of the paginated list of tools
 * - `gamma`: second page of the paginated list of tools
 * - `fail`: always fails (isError: true)
 * - `structured`: returns a structured content
 * - one resource and one prompt
 */
const createMcpServer = (options: TestMcpServerOptions, state: ServerState): Server => {
    const server = new Server(
        { name: 'wp-mcp-client-test-server', version: '1.0.0' },
        {
            capabilities: {
                // The listChanged capability must be advertised for the client to
                // register the handlers of the notifications.
                tools: { listChanged: true },
                resources: { listChanged: true },
                prompts: { listChanged: true }
            }
        }
    );

    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
        const cursor = request.params?.cursor as string | undefined;
        if (!cursor) {
            return {
                tools: [
                    {
                        name: 'alpha',
                        description: 'First tool of the first page',
                        inputSchema: { type: 'object', properties: { value: { type: 'string' } } }
                    },
                    {
                        name: 'beta',
                        description: 'Second tool of the first page',
                        inputSchema: { type: 'object', properties: {} }
                    },
                    {
                        name: 'fail',
                        description: 'Tool that always fails',
                        inputSchema: { type: 'object', properties: {} }
                    },
                    {
                        name: 'structured',
                        description: 'Tool that returns a structured content',
                        inputSchema: { type: 'object', properties: {} },
                        outputSchema: { type: 'object', properties: { total: { type: 'number' } } }
                    },
                    ...state.tools,
                    ...(options.extraTools ?? [])
                ],
                nextCursor: 'page-2'
            };
        }
        return {
            tools: [
                {
                    name: 'gamma',
                    description: 'Tool of the second page',
                    inputSchema: { type: 'object', properties: {} }
                }
            ]
        };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params.name;
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;
        if (name === 'fail') {
            return { isError: true, content: [{ type: 'text', text: 'the tool failed on purpose' }] };
        }
        if (name === 'structured') {
            return {
                content: [{ type: 'text', text: 'structured result' }],
                structuredContent: { total: 42 }
            };
        }
        return { content: [{ type: 'text', text: `echo:${JSON.stringify(args)}` }] };
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: [
            { uri: 'test://readme', name: 'readme', description: 'A test resource', mimeType: 'text/plain' }
        ]
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
        contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: 'the content of the resource' }]
    }));

    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
        prompts: [
            {
                name: 'greet',
                description: 'Greets somebody',
                arguments: [{ name: 'who', description: 'Name to greet', required: true }]
            }
        ]
    }));

    server.setRequestHandler(GetPromptRequestSchema, async (request) => ({
        description: 'A greeting',
        messages: [
            { role: 'user', content: { type: 'text', text: `Hello ${request.params.arguments?.who ?? 'world'}` } }
        ]
    }));

    return server;
};

/**
 * Start a real MCP server on a random local port.
 *
 * The server works in stateful mode: every client gets its own session (and
 * its own transport), which is the mode used by the specification.
 */
export const startTestMcpServer = async (options: TestMcpServerOptions = {}): Promise<TestMcpServer> => {
    const requests: RecordedRequest[] = [];
    const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
    const servers = new Map<string, Server>();
    const state: ServerState = { tools: [] };

    const createSession = async (): Promise<WebStandardStreamableHTTPServerTransport> => {
        const server = createMcpServer(options, state);
        let transport: WebStandardStreamableHTTPServerTransport;
        transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (sessionId: string) => {
                transports.set(sessionId, transport);
                servers.set(sessionId, server);
            },
            onsessionclosed: (sessionId: string) => {
                transports.delete(sessionId);
                servers.delete(sessionId);
            }
        });
        await server.connect(transport);
        return transport;
    };

    const httpServer = Bun.serve({
        port: 0,
        idleTimeout: 30,
        async fetch(request: Request): Promise<Response> {
            const headers: Record<string, string> = {};
            request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });

            let body: any = undefined;
            if (request.method === 'POST') {
                try {
                    body = await request.json();
                } catch {
                    body = undefined;
                }
            }
            requests.push({ method: body?.method ?? request.method, headers, body });

            if (options.requiredToken) {
                const authorization = headers['authorization'] ?? '';
                if (authorization !== `Bearer ${options.requiredToken}`) {
                    return new Response('Unauthorized', {
                        status: 401,
                        headers: {
                            'WWW-Authenticate': `Bearer resource_metadata="http://localhost:${httpServer.port}/.well-known/oauth-protected-resource"`
                        }
                    });
                }
            }

            const sessionId = request.headers.get('mcp-session-id');
            let transport: WebStandardStreamableHTTPServerTransport | undefined;
            if (sessionId) {
                transport = transports.get(sessionId);
                if (!transport) {
                    return new Response('Session not found', { status: 404 });
                }
            } else {
                transport = await createSession();
            }

            return await transport.handleRequest(
                request,
                body !== undefined ? { parsedBody: body } : {}
            );
        }
    });

    return {
        url: `http://localhost:${httpServer.port}/mcp`,
        requests,
        notifyToolsChanged: async () => {
            for (const server of servers.values()) {
                await server.sendToolListChanged();
            }
        },
        addTool: async (tool: Record<string, unknown>) => {
            state.tools.push(tool);
            for (const server of servers.values()) {
                await server.sendToolListChanged();
            }
        },
        stop: async () => {
            await httpServer.stop(true);
            for (const transport of transports.values()) {
                await transport.close();
            }
            for (const server of servers.values()) {
                await server.close();
            }
            transports.clear();
            servers.clear();
        }
    };
};
