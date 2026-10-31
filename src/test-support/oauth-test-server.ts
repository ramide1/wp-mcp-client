/**
 * Test helpers: a mock OAuth 2.1 authorization server and a protected MCP
 * server, used to exercise the OAuth flows end to end.
 */

import { createHash } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/** A request received by one of the mock servers. */
export interface OAuthRecordedRequest {
    method: string;
    path: string;
    headers: Record<string, string>;
    body?: any;
}

export interface TestOAuthServer {
    /** URL of the MCP endpoint (it answers 401 without a valid token). */
    mcpUrl: string;
    /** Client id accepted by the `client_credentials` grant. */
    serviceClientId: string;
    /** Client secret accepted by the `client_credentials` grant. */
    serviceClientSecret: string;
    /** Access token issued by the `client_credentials` grant. */
    serviceAccessToken: string;
    /** Requests received by the MCP server. */
    mcpRequests: OAuthRecordedRequest[];
    /** Requests received by the authorization server. */
    asRequests: OAuthRecordedRequest[];
    /** Stop both servers and release the ports. */
    stop: () => Promise<void>;
}

const base64url = (input: Buffer): string =>
    input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Credentials presented by the client at the token endpoint. */
interface ClientCredentials {
    clientId?: string;
    clientSecret?: string;
    method: 'none' | 'client_secret_post' | 'client_secret_basic';
}

/**
 * Read the credentials of the client, following the three authentication
 * methods of RFC 6749 §2.3.1.
 */
const readClientCredentials = (headers: Record<string, string>, form: URLSearchParams): ClientCredentials => {
    const authorization = headers['authorization'] ?? '';
    if (authorization.toLowerCase().startsWith('basic ')) {
        try {
            const decoded = Buffer.from(authorization.slice(6).trim(), 'base64').toString('utf8');
            const separator = decoded.indexOf(':');
            if (separator >= 0) {
                return {
                    clientId: decodeURIComponent(decoded.slice(0, separator)),
                    clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
                    method: 'client_secret_basic'
                };
            }
        } catch {
            // Malformed credentials: fall back to the ones of the body.
        }
    }
    if (form.has('client_secret')) {
        return {
            clientId: form.get('client_id') ?? undefined,
            clientSecret: form.get('client_secret') ?? undefined,
            method: 'client_secret_post'
        };
    }
    return {
        clientId: form.get('client_id') ?? undefined,
        clientSecret: undefined,
        method: 'none'
    };
};

/**
 * Start a mock OAuth 2.1 environment:
 * - an MCP server that requires a bearer token,
 * - an authorization server with dynamic registration, PKCE and the token endpoint.
 *
 * The authorization server implements the `authorization_code` grant (with
 * PKCE) and the `client_credentials` grant.
 */
export const startTestOAuthServer = async (): Promise<TestOAuthServer> => {
    const mcpRequests: OAuthRecordedRequest[] = [];
    const asRequests: OAuthRecordedRequest[] = [];

    const authorizationAccessToken = 'test-access-token';
    const serviceAccessToken = 'test-service-token';
    const serviceClientId = 'service-account';
    const serviceClientSecret = 'secret';

    /** PKCE challenges of the authorization codes that were issued. */
    const authorizationCodes = new Map<string, string>();
    /** Client ids issued by the dynamic registration endpoint. */
    const registeredClientIds = new Set<string>();

    // --- Authorization server -------------------------------------------------
    const asServer = Bun.serve({
        port: 0,
        async fetch(request: Request): Promise<Response> {
            const url = new URL(request.url);
            const headers: Record<string, string> = {};
            request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });

            // The body is read exactly once: it is parsed according to the
            // content type of the endpoint.
            let rawBody = '';
            if (request.method === 'POST') {
                rawBody = await request.text();
            }

            // The body of the request, parsed according to the endpoint.
            let body: any = undefined;
            if (request.method === 'POST') {
                if (url.pathname === '/token') {
                    const form = new URLSearchParams(rawBody);
                    body = {};
                    form.forEach((value, key) => { body[key] = value; });
                } else if (url.pathname === '/register') {
                    try {
                        body = JSON.parse(rawBody);
                    } catch {
                        body = undefined;
                    }
                }
            }
            asRequests.push({ method: request.method, path: url.pathname, headers, body });

            const origin = `http://localhost:${asServer.port}`;

            // RFC 8414: metadata of the authorization server
            if (url.pathname === '/.well-known/oauth-authorization-server') {
                return Response.json({
                    issuer: origin,
                    authorization_endpoint: `${origin}/authorize`,
                    token_endpoint: `${origin}/token`,
                    registration_endpoint: `${origin}/register`,
                    response_types_supported: ['code'],
                    grant_types_supported: ['authorization_code', 'client_credentials'],
                    code_challenge_methods_supported: ['S256'],
                    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic']
                });
            }

            // RFC 7591: dynamic client registration
            if (url.pathname === '/register' && request.method === 'POST') {
                const clientId = `test-client-${registeredClientIds.size + 1}`;
                registeredClientIds.add(clientId);
                return Response.json({
                    client_id: clientId,
                    redirect_uris: body?.redirect_uris ?? [],
                    token_endpoint_auth_method: 'none'
                }, { status: 201 });
            }

            // The user authorizes: the code is sent back to the redirect URI
            if (url.pathname === '/authorize') {
                const codeChallenge = url.searchParams.get('code_challenge') ?? '';
                const code = `auth-code-${authorizationCodes.size + 1}`;
                authorizationCodes.set(code, codeChallenge);
                const redirectUri = url.searchParams.get('redirect_uri') ?? '';
                const state = url.searchParams.get('state') ?? '';
                const location = new URL(redirectUri);
                location.searchParams.set('code', code);
                if (state) location.searchParams.set('state', state);
                return new Response(null, { status: 302, headers: { Location: location.toString() } });
            }

            // The code (or the client credentials) are exchanged for a token
            if (url.pathname === '/token' && request.method === 'POST') {
                const form = new URLSearchParams(rawBody);
                const grantType = form.get('grant_type') ?? '';

                if (grantType === 'client_credentials') {
                    const credentials = readClientCredentials(headers, form);
                    if (credentials.clientId !== serviceClientId || credentials.clientSecret !== serviceClientSecret) {
                        return Response.json({
                            error: 'invalid_client',
                            error_description: 'Unknown client or invalid client secret'
                        }, { status: 401 });
                    }
                    return Response.json({
                        access_token: serviceAccessToken,
                        token_type: 'Bearer',
                        expires_in: 3600,
                        scope: form.get('scope') ?? ''
                    });
                }

                if (grantType === 'authorization_code') {
                    const code = form.get('code') ?? '';
                    const verifier = form.get('code_verifier') ?? '';
                    const challenge = authorizationCodes.get(code);
                    if (!challenge) {
                        return Response.json({
                            error: 'invalid_grant',
                            error_description: 'Unknown authorization code'
                        }, { status: 400 });
                    }
                    const computed = base64url(createHash('sha256').update(verifier).digest());
                    if (computed !== challenge) {
                        return Response.json({
                            error: 'invalid_grant',
                            error_description: 'PKCE verification failed'
                        }, { status: 400 });
                    }
                    authorizationCodes.delete(code);
                    return Response.json({
                        access_token: authorizationAccessToken,
                        token_type: 'Bearer',
                        expires_in: 3600,
                        scope: form.get('scope') ?? ''
                    });
                }

                return Response.json({
                    error: 'unsupported_grant_type',
                    error_description: `Unsupported grant type: ${grantType}`
                }, { status: 400 });
            }

            return new Response('Not found', { status: 404 });
        }
    });

    // --- Protected MCP server -------------------------------------------------
    const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
    const servers = new Map<string, Server>();

    const createSession = async (): Promise<WebStandardStreamableHTTPServerTransport> => {
        const server = new Server(
            { name: 'oauth-test-server', version: '1.0.0' },
            { capabilities: { tools: {} } }
        );
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [{
                name: 'whoami',
                description: 'Returns the caller',
                inputSchema: { type: 'object', properties: {} }
            }]
        }));
        server.setRequestHandler(CallToolRequestSchema, async () => ({
            content: [{ type: 'text', text: 'authorized caller' }]
        }));

        let transport: WebStandardStreamableHTTPServerTransport;
        transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => `session-${servers.size + 1}-${Math.random().toString(36).slice(2)}`,
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

    const mcpServer = Bun.serve({
        port: 0,
        idleTimeout: 30,
        async fetch(request: Request): Promise<Response> {
            const url = new URL(request.url);
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
            mcpRequests.push({ method: request.method, path: url.pathname, headers, body });

            // RFC 9728: metadata of the protected resource
            if (url.pathname === '/.well-known/oauth-protected-resource') {
                return Response.json({
                    resource: `http://localhost:${mcpServer.port}/mcp`,
                    authorization_servers: [`http://localhost:${asServer.port}`],
                    bearer_methods_supported: ['header']
                });
            }

            if (url.pathname !== '/mcp') {
                return new Response('Not found', { status: 404 });
            }

            // The MCP endpoint requires a valid access token
            const authorization = headers['authorization'] ?? '';
            const validTokens = new Set([authorizationAccessToken, serviceAccessToken]);
            const presentedToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
            if (!validTokens.has(presentedToken)) {
                return new Response('Unauthorized', {
                    status: 401,
                    headers: {
                        'WWW-Authenticate': `Bearer resource_metadata="http://localhost:${mcpServer.port}/.well-known/oauth-protected-resource"`
                    }
                });
            }

            const sessionId = request.headers.get('mcp-session-id');
            let transport: WebStandardStreamableHTTPServerTransport | undefined;
            if (sessionId) {
                transport = transports.get(sessionId);
                if (!transport) return new Response('Session not found', { status: 404 });
            } else {
                transport = await createSession();
            }

            return await transport.handleRequest(request, body !== undefined ? { parsedBody: body } : {});
        }
    });

    return {
        mcpUrl: `http://localhost:${mcpServer.port}/mcp`,
        serviceClientId,
        serviceClientSecret,
        serviceAccessToken,
        mcpRequests,
        asRequests,
        stop: async () => {
            await mcpServer.stop(true);
            await asServer.stop(true);
            for (const transport of transports.values()) await transport.close();
            for (const server of servers.values()) await server.close();
            transports.clear();
            servers.clear();
        }
    };
};
