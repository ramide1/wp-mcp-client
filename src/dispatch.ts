/**
 * Dispatch of the tool calls requested by the model.
 *
 * The dispatcher owns the routing of every built-in function and enforces the
 * human-in-the-loop confirmation before a protected MCP tool is executed.
 * It is kept in a dedicated module (instead of `main.ts`) so the routing and
 * the confirmation rules can be unit tested without booting the WhatsApp client.
 */

import { MCPClientManager } from './mcp';
import type { SandboxRunner } from './sandbox';
import { formatSandboxResult } from './sandbox';
import { ConfirmationManager, confirmationRejectedMessage, type ConfirmationOutcome } from './confirm';
import { extractMcpResultText, extractResourceText, summarizeToolArgs } from './conversation';
import { truncateResult } from './text';
import { resetHistory, resetAllHistory } from './db';
import { createLogger } from './logger';
import type { SandboxStep } from './interface';

const log = createLogger('dispatch');

/** Maximum number of steps accepted by `execute_tool_sequence`. */
const MAX_SEQUENCE_STEPS = 20;

/** Options that depend on the environment of the bot. */
export interface DispatchOptions {
    /** Timeout of a sandbox execution, in milliseconds. */
    sandboxTimeoutMs: number;
    /** Maximum length of a tool result sent back to the model. */
    maxToolResultLength: number;
}

/** Context of a single tool call. */
export interface DispatchContext {
    /** Identifier of the user that requested the tool call. */
    user: string;
    /** WhatsApp address used to deliver the confirmation question. */
    to: string;
    /** True when the user is an administrator. */
    isAdmin: boolean;
}

/** Callback used to deliver a message to the user. */
export type Notify = (to: string, text: string) => Promise<void>;

export class ToolDispatcher {
    private readonly mcpClientManager: MCPClientManager;
    private readonly sandboxRunner: SandboxRunner;
    private readonly confirmationManager: ConfirmationManager;
    private readonly notify: Notify;
    private readonly options: DispatchOptions;

    constructor(
        mcpClientManager: MCPClientManager,
        sandboxRunner: SandboxRunner,
        confirmationManager: ConfirmationManager,
        notify: Notify,
        options: DispatchOptions
    ) {
        this.mcpClientManager = mcpClientManager;
        this.sandboxRunner = sandboxRunner;
        this.confirmationManager = confirmationManager;
        this.notify = notify;
        this.options = options;
    }

    /**
     * Execute the tool call requested by the model and return the text that is
     * sent back to it. Errors are reported as text: the model has to be able
     * to read them and decide what to do next.
     */
    public async dispatch(functionName: string, functionArgs: any, context: DispatchContext): Promise<string> {
        if (functionName === 'search_tools') return await this.searchTools(functionArgs);
        if (functionName === 'search_available_servers') return await this.searchAvailableServers();
        if (functionName === 'get_tool_details') return await this.getToolDetails(functionArgs);
        if (functionName === 'list_resources') return await this.listResources(functionArgs);
        if (functionName === 'read_resource') return await this.readResource(functionArgs);
        if (functionName === 'list_prompts') return await this.listPrompts(functionArgs);
        if (functionName === 'get_prompt') return await this.getPrompt(functionArgs);
        if (functionName === 'call_tool') return await this.callTool(functionArgs, context);
        if (functionName === 'execute_tool_sequence') return await this.executeToolSequence(functionArgs, context);
        if (functionName === 'execute_code') return await this.executeCode(functionArgs, context);

        // Direct loading mode: the model calls the MCP tool by its full name
        const parsedTool = MCPClientManager.parseToolName(functionName);
        if (parsedTool) {
            try {
                return await this.callMcpTool(parsedTool.serverName, parsedTool.toolName, functionArgs, context);
            } catch (error) {
                return `Error calling MCP tool ${parsedTool.toolName}: ${error instanceof Error ? error.message : String(error)}`;
            }
        }

        return this.dispatchHostFunction(functionName, functionArgs, context);
    }

    private async dispatchHostFunction(functionName: string, functionArgs: any, context: DispatchContext): Promise<string> {
        if (functionName === 'clean_current_chat') {
            return this.resetHistoryWithMessage(context.user, 'Message history cleared successfully', 'Error clearing message history');
        }
        if (context.isAdmin) {
            if (functionName === 'clean_chat') {
                const targetUser = functionArgs?.user;
                if (!targetUser) return 'Error: user parameter is required for clean_chat';
                return this.resetHistoryWithMessage(
                    targetUser,
                    'Message history for ' + targetUser + ' cleared successfully',
                    'Error clearing message history for ' + targetUser
                );
            }
            if (functionName === 'clean_all_chats') {
                try {
                    if (!resetAllHistory()) throw new Error('Error clearing all message history');
                    return 'All message history cleared successfully';
                } catch (error: any) {
                    return error.message;
                }
            }
        }
        return 'Unknown tool: ' + functionName;
    }

    private resetHistoryWithMessage(user: string, successMsg: string, errorPrefix: string): string {
        try {
            if (!resetHistory(user)) throw new Error(errorPrefix);
            return successMsg;
        } catch (error: any) {
            return error.message;
        }
    }

    private async searchTools(functionArgs: any): Promise<string> {
        try {
            const query = functionArgs?.query ?? '';
            const limit = functionArgs?.limit ?? 10;
            const detailLevel = functionArgs?.detailLevel ?? 'basic';
            const searchResults = await this.mcpClientManager.searchTools(query, limit, detailLevel);

            let resultText = 'Search results:\n';
            if (searchResults.length === 0) {
                resultText += 'No tools found matching the query.';
            } else {
                for (const result of searchResults) {
                    if (detailLevel === 'minimal') {
                        resultText += `- ${MCPClientManager.getFullToolName(result.serverName, result.toolName)}\n`;
                    } else if (detailLevel === 'full') {
                        resultText += `- ${MCPClientManager.getFullToolName(result.serverName, result.toolName)}: ${result.description}\n`;
                        if (result.inputSchema) {
                            resultText += `  Input Schema: ${JSON.stringify(result.inputSchema)}\n`;
                        }
                        if (result.outputSchema) {
                            resultText += `  Output Schema: ${JSON.stringify(result.outputSchema)}\n`;
                        }
                    } else {
                        resultText += `- ${MCPClientManager.getFullToolName(result.serverName, result.toolName)}: ${result.description}\n`;
                    }
                }
            }
            return resultText;
        } catch (error) {
            return `Error searching tools: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    private async searchAvailableServers(): Promise<string> {
        try {
            const servers = await this.mcpClientManager.getAvailableServers();
            let resultText = 'Available MCP servers:\n';
            if (servers.length === 0) {
                resultText += 'No MCP servers configured.';
            } else {
                for (const server of servers) {
                    const status = server.connected ? 'connected' : 'disconnected';
                    const toolCountText = server.toolCount === null ? 'tool count unknown' : `${server.toolCount} tools`;
                    resultText += `- ${server.name} [${status}]: ${server.description} (${toolCountText}, ${server.type})\n`;
                }
            }
            return resultText;
        } catch (error) {
            return `Error listing servers: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    private async getToolDetails(functionArgs: any): Promise<string> {
        try {
            const serverName = functionArgs?.serverName;
            const toolName = functionArgs?.toolName;
            if (!serverName || !toolName) {
                return 'Error: serverName and toolName are required';
            }
            const toolDetails = await this.mcpClientManager.getToolDetails(serverName, toolName);
            let resultText = `Tool Details:\n`;
            resultText += `Server: ${serverName}\n`;
            resultText += `Name: ${toolDetails.name}\n`;
            resultText += `Full Name: ${MCPClientManager.getFullToolName(serverName, toolDetails.name)}\n`;
            resultText += `Description: ${toolDetails.description || 'No description available'}\n`;
            if (toolDetails.inputSchema) {
                resultText += `Input Schema: ${JSON.stringify(toolDetails.inputSchema, null, 2)}\n`;
            } else {
                resultText += `Input Schema: Not available\n`;
            }
            if (toolDetails.outputSchema) {
                resultText += `Output Schema: ${JSON.stringify(toolDetails.outputSchema, null, 2)}\n`;
            } else {
                resultText += `Output Schema: Not available\n`;
            }
            return resultText;
        } catch (error) {
            return `Error getting tool details: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    private async listResources(functionArgs: any): Promise<string> {
        try {
            const serverName = functionArgs?.serverName;
            const resources = await this.mcpClientManager.listResources(serverName);
            let resultText = 'Available resources:\n';
            if (resources.length === 0) {
                resultText += 'No resources found.';
            } else {
                for (const resource of resources) {
                    resultText += `- ${resource.serverName}: ${resource.uri}`;
                    if (resource.name) resultText += ` (${resource.name})`;
                    if (resource.description) resultText += ` - ${resource.description}`;
                    if (resource.mimeType) resultText += ` [${resource.mimeType}]`;
                    resultText += '\n';
                }
            }
            return resultText;
        } catch (error) {
            return `Error listing resources: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    private async readResource(functionArgs: any): Promise<string> {
        try {
            const serverName = functionArgs?.serverName;
            const uri = functionArgs?.uri;
            if (!serverName || !uri) {
                return 'Error: serverName and uri are required';
            }
            const result = await this.mcpClientManager.readResource(serverName, uri);
            return this.truncate(extractResourceText(result));
        } catch (error) {
            return `Error reading resource: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    private async listPrompts(functionArgs: any): Promise<string> {
        try {
            const serverName = functionArgs?.serverName;
            const prompts = await this.mcpClientManager.listPrompts(serverName);
            let resultText = 'Available prompts:\n';
            if (prompts.length === 0) {
                resultText += 'No prompts found.';
            } else {
                for (const prompt of prompts) {
                    resultText += `- ${prompt.serverName}: ${prompt.name}`;
                    if (prompt.description) resultText += ` - ${prompt.description}`;
                    if (prompt.arguments && prompt.arguments.length > 0) {
                        const argNames = prompt.arguments
                            .map(arg => arg.name + (arg.required ? ' (required)' : ''))
                            .join(', ');
                        resultText += ` (arguments: ${argNames})`;
                    }
                    resultText += '\n';
                }
            }
            return resultText;
        } catch (error) {
            return `Error listing prompts: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    private async getPrompt(functionArgs: any): Promise<string> {
        try {
            const serverName = functionArgs?.serverName;
            const name = functionArgs?.name;
            const promptArgs = functionArgs?.arguments ?? {};
            if (!serverName || !name) {
                return 'Error: serverName and name are required';
            }
            const result = await this.mcpClientManager.getPrompt(serverName, name, promptArgs);
            const promptMessages = (result as {
                messages?: Array<{ role?: string; content?: { type?: string; text?: string } }>;
            })?.messages;
            let resultText = `Prompt ${name}:\n`;
            if (Array.isArray(promptMessages)) {
                for (const promptMessage of promptMessages) {
                    const content = promptMessage.content;
                    const text = typeof content?.text === 'string' ? content.text : JSON.stringify(content);
                    resultText += `[${promptMessage.role ?? 'message'}] ${text}\n`;
                }
            } else {
                resultText += JSON.stringify(result);
            }
            return this.truncate(resultText);
        } catch (error) {
            return `Error getting prompt: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    /**
     * Call an MCP tool through the stable `call_tool` wrapper.
     */
    private async callTool(functionArgs: any, context: DispatchContext): Promise<string> {
        try {
            const serverName = functionArgs?.serverName;
            const toolName = functionArgs?.toolName;
            const args = functionArgs?.args ?? {};
            if (!serverName || !toolName) {
                return 'Error: serverName and toolName are required';
            }
            return await this.callMcpTool(serverName, toolName, args, context);
        } catch (error) {
            return `Error calling tool: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    /**
     * Call an MCP tool, enforcing the confirmation when the policy requires it.
     */
    private async callMcpTool(
        serverName: string,
        toolName: string,
        args: any,
        context: DispatchContext
    ): Promise<string> {
        const fullName = MCPClientManager.getFullToolName(serverName, toolName);
        const outcome = await this.confirmToolCall(context, fullName, args);
        if (outcome !== undefined && outcome !== 'approved') {
            return confirmationRejectedMessage(outcome);
        }
        const result = await this.mcpClientManager.callTool(serverName, toolName, args);
        return this.truncate(extractMcpResultText(result));
    }

    /**
     * Execute a sequence of MCP tool calls in a sandboxed subprocess.
     */
    private async executeToolSequence(functionArgs: any, context: DispatchContext): Promise<string> {
        try {
            const steps = functionArgs?.steps ?? [];
            const summaryPrompt = functionArgs?.summary ?? 'Summarize the results';

            if (!Array.isArray(steps) || steps.length === 0) {
                return 'Error: steps must be a non-empty array';
            }
            if (steps.length > MAX_SEQUENCE_STEPS) {
                return `Error: too many steps (${steps.length}). Maximum allowed is ${MAX_SEQUENCE_STEPS}`;
            }

            // Validate all steps upfront
            const validatedSteps: SandboxStep[] = [];
            for (let i = 0; i < steps.length; i++) {
                const step = steps[i];
                if (!step || typeof step !== 'object') {
                    validatedSteps.push({ index: i, serverName: '', toolName: '', args: {}, valid: false, error: 'step must be an object' });
                    continue;
                }
                const { serverName, toolName, args, saveAs, useResultFrom } = step;
                if (!serverName || !toolName) {
                    validatedSteps.push({ index: i, serverName: '', toolName: '', args: {}, valid: false, error: 'serverName and toolName are required' });
                    continue;
                }
                if (typeof serverName !== 'string' || typeof toolName !== 'string') {
                    validatedSteps.push({ index: i, serverName: '', toolName: '', args: {}, valid: false, error: 'serverName and toolName must be strings' });
                    continue;
                }
                if (saveAs && (typeof saveAs !== 'string' || saveAs === '__proto__' || saveAs === 'constructor' || saveAs === 'prototype')) {
                    validatedSteps.push({ index: i, serverName: '', toolName: '', args: {}, valid: false, error: 'invalid saveAs key' });
                    continue;
                }
                validatedSteps.push({ index: i, serverName, toolName, args: args ?? {}, saveAs, useResultFrom, valid: true });
            }

            const toolStubs = await this.mcpClientManager.getToolsForSandbox();
            if (toolStubs.length === 0) {
                return 'No MCP tools available. Connect to an MCP server first.';
            }

            // Every tool of the sequence that needs approval is confirmed at once
            const sequenceTools = validatedSteps
                .filter(step => step.valid)
                .map(step => MCPClientManager.getFullToolName(step.serverName, step.toolName));
            const protectedTools = sequenceTools.filter(tool => this.confirmationManager.requiresConfirmation(tool));
            const outcome = protectedTools.length > 0
                ? await this.confirmToolCall(context, protectedTools.join(', '), { steps: validatedSteps }, true)
                : undefined;
            if (outcome !== undefined && outcome !== 'approved') {
                return confirmationRejectedMessage(outcome);
            }

            const result = await this.sandboxRunner.executeToolSequence(validatedSteps, toolStubs, this.options.sandboxTimeoutMs, summaryPrompt);
            return formatSandboxResult(result);
        } catch (error) {
            return `Error executing tool sequence: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    /**
     * Execute model generated code in a sandboxed subprocess.
     */
    private async executeCode(functionArgs: any, context: DispatchContext): Promise<string> {
        try {
            const code = functionArgs?.code;
            if (!code || typeof code !== 'string') {
                return 'Error: code must be a non-empty string';
            }

            const toolStubs = await this.mcpClientManager.getToolsForSandbox();
            if (toolStubs.length === 0) {
                return 'No MCP tools available for sandbox execution. Connect to an MCP server first.';
            }

            // The code is opaque: it may call any tool, so it is confirmed
            // when at least one of the available tools requires approval.
            const protectedTools = toolStubs
                .map(stub => stub.fullName)
                .filter(tool => this.confirmationManager.requiresConfirmation(tool));
            const outcome = protectedTools.length > 0
                ? await this.confirmToolCall(context, 'execute_code', { code }, true)
                : undefined;
            if (outcome !== undefined && outcome !== 'approved') {
                return confirmationRejectedMessage(outcome);
            }

            const result = await this.sandboxRunner.execute(code, toolStubs, this.options.sandboxTimeoutMs);
            return formatSandboxResult(result);
        } catch (error) {
            return `Error in sandbox execution: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    /**
     * Ask the user to approve a tool call before it is executed.
     * Returns the outcome of the request, or undefined when no confirmation was needed.
     */
    private async confirmToolCall(
        context: DispatchContext,
        toolName: string,
        args: unknown,
        force: boolean = false
    ): Promise<ConfirmationOutcome | undefined> {
        if (!force && !this.confirmationManager.requiresConfirmation(toolName)) return undefined;
        const outcome = await this.confirmationManager.request(
            context.user,
            { toolName, args, summary: summarizeToolArgs(args) },
            async (question) => { await this.notify(context.to, question); }
        );
        if (outcome !== 'approved') {
            log.info('Tool call not approved by the user', { user: context.user, tool: toolName, outcome });
        }
        return outcome;
    }

    private truncate(text: string): string {
        return truncateResult(text, this.options.maxToolResultLength);
    }
}
