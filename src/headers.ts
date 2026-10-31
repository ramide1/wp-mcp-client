/**
 * SEP-2243 support: mirroring tool parameters into HTTP headers.
 *
 * A server may annotate a property of a tool's `inputSchema` with
 * `x-mcp-header: "{Name}"`. A conforming Streamable HTTP client then mirrors the
 * value of that parameter into the `Mcp-Param-{Name}` request header, so that
 * gateways can route a call without parsing the body.
 *
 * Reference: https://modelcontextprotocol.io/seps/2243-http-standardization
 */

export const X_MCP_HEADER_KEY = 'x-mcp-header';
export const MCP_PARAM_HEADER_PREFIX = 'Mcp-Param-';

/** RFC 9110 §5.1 `token` syntax (1*tchar). */
const RFC9110_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * JSON Schema types accepted on an `x-mcp-header` property.
 *
 * The spec text only allows `string`, `integer` and `boolean`. The MCP
 * conformance referee also ships `number` annotated parameters and expects them
 * to be mirrored, so `number` is accepted here to stay interoperable.
 */
const PERMITTED_TYPES = new Set(['string', 'integer', 'boolean', 'number']);

export interface HeaderDeclaration {
    /** Chain of `properties` keys leading to the annotated property. */
    path: string[];
    /** Declared header suffix: the `{Name}` of `Mcp-Param-{Name}`. */
    name: string;
    /** JSON Schema type of the annotated property. */
    type: string;
}

export interface HeaderScanResult {
    declarations: HeaderDeclaration[];
    /** Reasons why the tool definition must be rejected. Empty when valid. */
    errors: string[];
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const declaredType = (schema: Record<string, unknown>): string | undefined => {
    const type = schema.type;
    if (typeof type === 'string') return type;
    if (Array.isArray(type)) {
        const types = type.filter((entry): entry is string => typeof entry === 'string');
        return types.length === 1 ? types[0] : undefined;
    }
    return undefined;
};

/**
 * Scan a tool `inputSchema` for `x-mcp-header` annotations.
 *
 * Only properties reachable through `properties` chains are inspected, as
 * required by the spec. Every constraint violation is reported so the caller
 * can exclude the tool from the registry.
 */
export const scanHeaderDeclarations = (inputSchema: unknown): HeaderScanResult => {
    const declarations: HeaderDeclaration[] = [];
    const errors: string[] = [];
    const seenNames = new Map<string, string>();

    const walk = (schema: unknown, path: string[]): void => {
        if (!isPlainObject(schema)) return;
        const properties = schema.properties;
        if (!isPlainObject(properties)) return;

        for (const [key, propertySchema] of Object.entries(properties)) {
            if (!isPlainObject(propertySchema)) continue;
            const childPath = [...path, key];
            const annotation = propertySchema[X_MCP_HEADER_KEY];

            if (annotation !== undefined) {
                if (typeof annotation !== 'string' || annotation.length === 0) {
                    errors.push(`property "${childPath.join('.')}" has an empty or non-string ${X_MCP_HEADER_KEY} annotation`);
                } else if (!RFC9110_TOKEN.test(annotation)) {
                    errors.push(`property "${childPath.join('.')}" declares an invalid header name "${annotation}"`);
                } else {
                    const lower = annotation.toLowerCase();
                    const previous = seenNames.get(lower);
                    if (previous !== undefined) {
                        errors.push(`header name "${annotation}" is declared more than once (also on "${previous}")`);
                    } else {
                        seenNames.set(lower, childPath.join('.'));
                        const type = declaredType(propertySchema);
                        if (type === undefined) {
                            errors.push(`property "${childPath.join('.')}" declares ${X_MCP_HEADER_KEY} but has no single JSON Schema type`);
                        } else if (!PERMITTED_TYPES.has(type)) {
                            errors.push(`property "${childPath.join('.')}" declares ${X_MCP_HEADER_KEY} on a "${type}" parameter; only primitive types are allowed`);
                        } else {
                            declarations.push({ path: childPath, name: annotation, type });
                        }
                    }
                }
            }

            walk(propertySchema, childPath);
        }
    };

    walk(inputSchema, []);

    return { declarations, errors };
};

/** Sentinel that marks a Base64 encoded header value (case sensitive). */
const BASE64_SENTINEL_PREFIX = '=?base64?';
const BASE64_SENTINEL_SUFFIX = '?=';

const toBase64 = (value: string): string => {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
};

/**
 * Encode a parameter value so it can safely travel in an HTTP header.
 *
 * Values that are not plain printable ASCII, or that start/end with whitespace,
 * or that collide with the Base64 sentinel, are Base64 encoded using the
 * `=?base64?<data>?=` form defined by the spec.
 */
export const encodeHeaderValue = (value: string): string => {
    const startsOrEndsWithWhitespace = value.startsWith(' ') || value.startsWith('\t') ||
        value.endsWith(' ') || value.endsWith('\t');
    const isPrintableAscii = /^[\x20-\x7E]*$/.test(value);
    const hasControlChars = /[\x00-\x1F\x7F]/.test(value);
    const collidesWithSentinel = value.startsWith(BASE64_SENTINEL_PREFIX) && value.endsWith(BASE64_SENTINEL_SUFFIX);

    if (startsOrEndsWithWhitespace || !isPrintableAscii || hasControlChars || collidesWithSentinel) {
        return BASE64_SENTINEL_PREFIX + toBase64(value) + BASE64_SENTINEL_SUFFIX;
    }
    return value;
};

const stringifyPrimitive = (value: unknown, type: string): string | undefined => {
    switch (type) {
        case 'string':
            return typeof value === 'string' ? value : undefined;
        case 'integer':
            if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
            if (typeof value === 'string' && /^-?\d+$/.test(value)) return value;
            return undefined;
        case 'boolean':
            if (typeof value === 'boolean') return value ? 'true' : 'false';
            return undefined;
        case 'number':
            if (typeof value === 'number' && Number.isFinite(value)) return String(value);
            return undefined;
        default:
            return undefined;
    }
};

const resolvePath = (args: Record<string, unknown>, path: string[]): unknown => {
    let current: unknown = args;
    for (const key of path) {
        if (!isPlainObject(current)) return undefined;
        current = current[key];
    }
    return current;
};

/**
 * Build the `Mcp-Param-*` headers for a tool call.
 *
 * Parameters that are absent or `null` are omitted, as required by the spec.
 */
export const buildParamHeaders = (
    declarations: HeaderDeclaration[],
    args: Record<string, unknown>
): Record<string, string> => {
    const headers: Record<string, string> = {};
    for (const declaration of declarations) {
        const raw = resolvePath(args, declaration.path);
        if (raw === undefined || raw === null) continue;
        const stringValue = stringifyPrimitive(raw, declaration.type);
        if (stringValue === undefined) continue;
        headers[MCP_PARAM_HEADER_PREFIX + declaration.name] = encodeHeaderValue(stringValue);
    }
    return headers;
};
