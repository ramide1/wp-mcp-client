/**
 * Admin commands of the bot.
 *
 * They are parsed and handled in a dedicated module (instead of `main.ts`) so
 * their behaviour can be unit tested without a WhatsApp client.
 */

/** The `/oauth` command: shows the authorization URL or finishes the flow. */
export interface OAuthCommand {
    name: 'oauth';
    /** Name of the MCP server. Empty when the command was sent without arguments. */
    serverName: string;
    /** Authorization code returned by the authorization server. */
    code?: string;
}

/** Any command understood by the bot. */
export type AdminCommand = OAuthCommand;

/** Usage of the `/oauth` command. */
export const OAUTH_USAGE = 'Usage: /oauth <serverName> [authorizationCode]';

/**
 * Parse an admin command.
 *
 * @returns The command, or undefined when the text is not a command.
 */
export const parseAdminCommand = (messageText: string): AdminCommand | undefined => {
    const text = (messageText ?? '').trim();
    if (!text.startsWith('/oauth')) return undefined;
    const rest = text.slice('/oauth'.length);
    // "/oauthfoo" is not the command "/oauth"
    if (rest !== '' && !/^\s/.test(rest)) return undefined;

    const parts = rest.trim().split(/\s+/).filter(part => part.length > 0);
    return {
        name: 'oauth',
        serverName: parts[0] ?? '',
        code: parts.slice(1).join(' ') || undefined
    };
};

/** Services the commands need to do their job. */
export interface AdminCommandDependencies {
    /** URL the operator has to open to authorize the client, when it is pending. */
    getAuthorizationUrl: (serverName: string) => string | undefined;
    /** Finish an interactive authorization flow with the code of the user. */
    completeAuthorization: (serverName: string, authorizationCode: string) => Promise<void>;
}

/**
 * Handle the `/oauth` command.
 *
 * - Without a code: it returns the authorization URL of the pending flow.
 * - With a code: it finishes the flow.
 */
export const handleOAuthCommand = async (
    command: OAuthCommand,
    dependencies: AdminCommandDependencies
): Promise<string> => {
    if (!command.serverName) return OAUTH_USAGE;

    if (!command.code) {
        const url = dependencies.getAuthorizationUrl(command.serverName);
        if (!url) {
            return `No pending authorization for "${command.serverName}". The URL is generated when the server rejects a call: try it first and then ask again.`;
        }
        return `Open this URL to authorize "${command.serverName}", then send the code with "${OAUTH_USAGE.replace('Usage: ', '')}":\n${url}`;
    }

    try {
        await dependencies.completeAuthorization(command.serverName, command.code);
        return `Authorization completed for "${command.serverName}". The next tool call will reconnect the server.`;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Could not complete the authorization of "${command.serverName}": ${message}`;
    }
};

/**
 * Handle any admin command.
 *
 * @returns The answer to send to the user, or undefined when the text is not
 * a command.
 */
export const handleAdminCommand = async (
    messageText: string,
    dependencies: AdminCommandDependencies
): Promise<string | undefined> => {
    const command = parseAdminCommand(messageText);
    if (!command) return undefined;
    return await handleOAuthCommand(command, dependencies);
};
