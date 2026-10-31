/**
 * OAuth 2.1 support for remote (Streamable HTTP) MCP servers.
 *
 * Two grants are supported:
 * - `client_credentials`: machine to machine, no user interaction. Used when the
 *   server only exposes a protected resource to a service account.
 * - `authorization_code`: interactive, with PKCE. The provider exposes the
 *   authorization URL through `onAuthorizationRequired` and the caller completes
 *   the flow with `finishAuthorization(code)`.
 *
 * Tokens, client information and the PKCE verifier are persisted in a JSON file
 * (inside `auth/`, which is gitignored) so a restart does not force a new
 * authorization round trip.
 */

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
    OAuthClientInformation,
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { createLogger } from './logger';

const log = createLogger('oauth');

export type OAuthGrant = 'client_credentials' | 'authorization_code';

export interface OAuthServerConfig {
    /** Grant type. Defaults to `authorization_code` when a client id is given, `client_credentials` otherwise. */
    grant?: OAuthGrant;
    /** Pre-registered OAuth client id. */
    clientId?: string;
    /** Client secret, for confidential clients. */
    clientSecret?: string;
    /** Space separated list of requested scopes. */
    scope?: string;
    /** Redirect URI registered for the authorization code flow. */
    redirectUri?: string;
    /** Authorization endpoint. Discovered from the metadata when omitted. */
    authorizationUrl?: string;
    /** Token endpoint. Discovered from the metadata when omitted. */
    tokenUrl?: string;
    /** Register the client dynamically (RFC 7591) when no client id is configured. */
    dynamicRegistration?: boolean;
    /** Client name advertised during dynamic registration. */
    clientName?: string;
    /** Path of the file used to persist tokens. Defaults to `auth/oauth-<server>.json`. */
    tokenFile?: string;
}

interface PersistedState {
    clientInformation?: OAuthClientInformationMixed;
    tokens?: OAuthTokens;
    codeVerifier?: string;
}

export interface OAuthProviderOptions extends OAuthServerConfig {
    serverName: string;
    serverUrl: string;
    /** Called when the user must open an authorization URL to grant access. */
    onAuthorizationRequired?: (authorizationUrl: string) => void;
}

/**
 * OAuth client provider backed by a JSON file.
 */
export class McpOAuthProvider implements OAuthClientProvider {
    private readonly options: OAuthProviderOptions;
    private readonly grant: OAuthGrant;
    private readonly storePath: string;
    private persisted: PersistedState = {};
    private pendingAuthorizationUrl: string | undefined;
    private oauthState: string | undefined;

    constructor(options: OAuthProviderOptions) {
        this.options = options;
        this.grant = options.grant ?? (options.clientSecret ? 'client_credentials' : 'authorization_code');
        this.storePath = options.tokenFile ?? `auth/oauth-${options.serverName}.json`;
        this.load();
    }

    /** The authorization URL the user has to open, when the flow is pending. */
    public get authorizationUrl(): string | undefined {
        return this.pendingAuthorizationUrl;
    }

    /** True when the provider has a usable access token. */
    public get hasTokens(): boolean {
        return !!this.persisted.tokens?.access_token;
    }

    public get redirectUrl(): string | undefined {
        return this.options.redirectUri;
    }

    public get clientMetadata(): OAuthClientMetadata {
        const redirectUris = this.options.redirectUri ? [this.options.redirectUri] : [];
        return {
            redirect_uris: redirectUris,
            client_name: this.options.clientName ?? `wp-mcp-client (${this.options.serverName})`,
            grant_types: [this.grant === 'client_credentials' ? 'client_credentials' : 'authorization_code'],
            response_types: [this.grant === 'client_credentials' ? undefined : 'code'].filter(Boolean) as string[],
            token_endpoint_auth_method: this.options.clientSecret ? 'client_secret_basic' : 'none',
            ...(this.options.scope ? { scope: this.options.scope } : {})
        };
    }

    public clientInformation(): OAuthClientInformationMixed | undefined {
        if (this.persisted.clientInformation) return this.persisted.clientInformation;
        if (!this.options.clientId) return undefined;
        const info: OAuthClientInformation = {
            client_id: this.options.clientId,
            ...(this.options.clientSecret ? { client_secret: this.options.clientSecret } : {})
        };
        return info;
    }

    public saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
        this.persisted.clientInformation = clientInformation;
        this.persist();
    }

    public tokens(): OAuthTokens | undefined {
        return this.persisted.tokens;
    }

    public saveTokens(tokens: OAuthTokens): void {
        this.persisted.tokens = tokens;
        this.persist();
    }

    /**
     * Random OAuth `state` parameter.
     * A fresh value is generated on every call, so two authorization flows can
     * never share a state value (anti-replay).
     */
    public state(): string {
        this.oauthState = randomUUID();
        return this.oauthState;
    }

    public redirectToAuthorization(authorizationUrl: URL): void {
        this.pendingAuthorizationUrl = authorizationUrl.toString();
        log.info('OAuth authorization required', { server: this.options.serverName, url: this.pendingAuthorizationUrl });
        this.options.onAuthorizationRequired?.(this.pendingAuthorizationUrl);
    }

    public saveCodeVerifier(codeVerifier: string): void {
        this.persisted.codeVerifier = codeVerifier;
        this.persist();
    }

    public codeVerifier(): string {
        if (!this.persisted.codeVerifier) {
            throw new Error(`No PKCE code verifier stored for MCP server ${this.options.serverName}`);
        }
        return this.persisted.codeVerifier;
    }

    public invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
        if (scope === 'all' || scope === 'tokens') this.persisted.tokens = undefined;
        if (scope === 'all' || scope === 'client') this.persisted.clientInformation = undefined;
        if (scope === 'all' || scope === 'verifier') this.persisted.codeVerifier = undefined;
        this.persist();
    }

    /**
     * Build the token request parameters for the configured grant.
     * `client_credentials` needs the client id/secret, `authorization_code`
     * needs the code, the PKCE verifier and the redirect URI.
     */
    public prepareTokenRequest(scope?: string): URLSearchParams | undefined {
        if (this.grant === 'client_credentials') {
            const params = new URLSearchParams({ grant_type: 'client_credentials' });
            if (scope ?? this.options.scope) params.set('scope', (scope ?? this.options.scope)!);
            return params;
        }
        // Default behaviour of the SDK already builds the authorization_code request.
        return undefined;
    }

    private load(): void {
        try {
            if (!existsSync(this.storePath)) return;
            const parsed = JSON.parse(readFileSync(this.storePath, 'utf8')) as PersistedState;
            this.persisted = parsed ?? {};
            if (this.persisted.tokens?.access_token) {
                log.info('Loaded persisted OAuth tokens', { server: this.options.serverName });
            }
        } catch (error) {
            log.warn('Could not read persisted OAuth state', {
                server: this.options.serverName,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    private persist(): void {
        try {
            const directory = dirname(this.storePath);
            if (directory && !existsSync(directory)) mkdirSync(directory, { recursive: true });
            writeFileSync(this.storePath, JSON.stringify(this.persisted, null, 2), 'utf8');
        } catch (error) {
            log.warn('Could not persist OAuth state', {
                server: this.options.serverName,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }
}

/**
 * Build the OAuth provider for a server configuration, if it declares OAuth.
 * Returns undefined when the server does not use OAuth.
 */
export const createOAuthProvider = (options: OAuthProviderOptions): McpOAuthProvider | undefined => {
    const hasOAuth = !!(options.clientId || options.dynamicRegistration || options.grant);
    if (!hasOAuth) return undefined;
    return new McpOAuthProvider(options);
};
