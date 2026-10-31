/**
 * Minimal JSON Schema validator used to validate MCP tool arguments and results.
 *
 * MCP tools declare `inputSchema`/`outputSchema` as JSON Schema. The 2026-07-28 spec defaults to
 * JSON Schema 2020-12 and requires `$ref` resolution, so this validator supports the keywords that
 * actually appear in tool schemas instead of only the flat top-level subset.
 *
 * Supported: $ref (internal pointers), type, enum, const, required, properties,
 * additionalProperties, items, minItems/maxItems/uniqueItems, minLength/maxLength/pattern,
 * minimum/maximum/exclusiveMinimum/exclusiveMaximum/multipleOf, minProperties/maxProperties,
 * allOf, anyOf, oneOf, not.
 *
 * Unknown keywords are ignored (per JSON Schema semantics).
 */

export type JsonSchema = Record<string, any> | boolean | undefined | null;

const MAX_DEPTH = 32;

/** JSON pointer escape/unescape (RFC 6901). */
const decodePointerSegment = (segment: string): string =>
    segment.replace(/~1/g, '/').replace(/~0/g, '~');

/**
 * Resolve an internal `$ref` (`#/definitions/x`, `#/$defs/x`, ...) against the root schema.
 * External references are not resolvable locally and are ignored.
 * Sibling keywords next to `$ref` are merged on top of the resolved schema (2020-12 behaviour).
 */
const resolveRef = (schema: any, root: any, seenRefs: Set<string>): any => {
    if (!schema || typeof schema !== 'object' || typeof schema.$ref !== 'string') return schema;

    const ref: string = schema.$ref;
    if (!ref.startsWith('#/')) {
        const { $ref, ...siblings } = schema;
        return siblings;
    }
    if (seenRefs.has(ref)) return {}; // cyclic reference: stop validating this branch

    seenRefs.add(ref);
    let target: any = root;
    for (const segment of ref.slice(2).split('/')) {
        if (target === null || typeof target !== 'object') {
            seenRefs.delete(ref);
            return {};
        }
        target = target[decodePointerSegment(segment)];
    }
    const resolved = resolveRef(target, root, seenRefs);
    seenRefs.delete(ref);

    const { $ref, ...siblings } = schema;
    return Object.keys(siblings).length > 0 ? { ...resolved, ...siblings } : resolved;
};

const actualType = (value: any): string => {
    if (Array.isArray(value)) return 'array';
    if (value === null) return 'null';
    return typeof value;
};

const typeMatches = (value: any, expected: any): boolean => {
    if (Array.isArray(expected)) return expected.some(t => typeMatches(value, t));
    const actual = actualType(value);
    if (expected === 'integer') return actual === 'number' && Number.isInteger(value);
    if (expected === 'number') return actual === 'number';
    return actual === expected;
};

const deepEqual = (a: any, b: any): boolean => {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
        if (a.length !== b.length) return false;
        return a.every((item, index) => deepEqual(item, b[index]));
    }
    if (typeof a !== 'object') return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(key => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
};

const joinPath = (path: string, key: string): string => (path ? `${path}.${key}` : key);

/**
 * Validate a value against a schema, collecting human readable errors.
 * @param value Value to validate
 * @param schema JSON Schema to validate against
 * @param root Root schema used to resolve `$ref` (defaults to `schema`)
 * @param path Property path used in error messages
 */
const validateValue = (
    value: any,
    schema: any,
    root: any,
    path: string,
    errors: string[],
    depth: number,
    seenRefs: Set<string>
): void => {
    if (schema === undefined || schema === null || depth > MAX_DEPTH) return;

    if (schema === false) {
        errors.push(`field '${path}' is not allowed`);
        return;
    }
    if (typeof schema !== 'object') return;

    const resolved = resolveRef(schema, root, seenRefs);
    if (resolved === false) {
        errors.push(`field '${path}' is not allowed`);
        return;
    }
    if (!resolved || typeof resolved !== 'object') return;

    if (resolved.type !== undefined && !typeMatches(value, resolved.type)) {
        const expected = Array.isArray(resolved.type) ? resolved.type.join(' or ') : resolved.type;
        errors.push(`field '${path}' expected type ${expected}, got ${actualType(value)}`);
        return; // further checks would only produce noise
    }

    if (resolved.const !== undefined && !deepEqual(value, resolved.const)) {
        errors.push(`field '${path}' must be ${JSON.stringify(resolved.const)}`);
    }

    if (Array.isArray(resolved.enum) && !resolved.enum.some((allowed: any) => deepEqual(value, allowed))) {
        errors.push(`field '${path}' must be one of: ${resolved.enum.map((v: any) => JSON.stringify(v)).join(', ')}`);
    }

    if (typeof value === 'string') {
        if (resolved.minLength !== undefined && value.length < resolved.minLength) {
            errors.push(`field '${path}' must be at least ${resolved.minLength} characters`);
        }
        if (resolved.maxLength !== undefined && value.length > resolved.maxLength) {
            errors.push(`field '${path}' must be at most ${resolved.maxLength} characters`);
        }
        if (typeof resolved.pattern === 'string') {
            try {
                if (!new RegExp(resolved.pattern).test(value)) {
                    errors.push(`field '${path}' does not match pattern: ${resolved.pattern}`);
                }
            } catch {
                // invalid regex in schema: skip the check rather than blocking the call
            }
        }
    }

    if (typeof value === 'number') {
        if (resolved.minimum !== undefined && value < resolved.minimum) {
            errors.push(`field '${path}' must be >= ${resolved.minimum}`);
        }
        if (resolved.maximum !== undefined && value > resolved.maximum) {
            errors.push(`field '${path}' must be <= ${resolved.maximum}`);
        }
        if (resolved.exclusiveMinimum !== undefined && value <= resolved.exclusiveMinimum) {
            errors.push(`field '${path}' must be > ${resolved.exclusiveMinimum}`);
        }
        if (resolved.exclusiveMaximum !== undefined && value >= resolved.exclusiveMaximum) {
            errors.push(`field '${path}' must be < ${resolved.exclusiveMaximum}`);
        }
        if (resolved.multipleOf !== undefined && resolved.multipleOf > 0) {
            const ratio = value / resolved.multipleOf;
            if (Math.abs(ratio - Math.round(ratio)) > 1e-9) {
                errors.push(`field '${path}' must be a multiple of ${resolved.multipleOf}`);
            }
        }
    }

    if (Array.isArray(value)) {
        if (resolved.minItems !== undefined && value.length < resolved.minItems) {
            errors.push(`field '${path}' must have at least ${resolved.minItems} items`);
        }
        if (resolved.maxItems !== undefined && value.length > resolved.maxItems) {
            errors.push(`field '${path}' must have at most ${resolved.maxItems} items`);
        }
        if (resolved.uniqueItems === true) {
            const seen = new Set<string>();
            for (const item of value) {
                const serialized = JSON.stringify(item);
                if (seen.has(serialized)) {
                    errors.push(`field '${path}' must contain unique items`);
                    break;
                }
                seen.add(serialized);
            }
        }
        if (resolved.items !== undefined) {
            value.forEach((item, index) => {
                validateValue(item, resolved.items, root, `${path}[${index}]`, errors, depth + 1, seenRefs);
            });
        }
    }

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const properties: Record<string, any> = resolved.properties || {};
        const required: string[] = Array.isArray(resolved.required) ? resolved.required : [];

        for (const field of required) {
            if (!(field in value) || value[field] === undefined) {
                errors.push(`missing required field '${joinPath(path, field)}'`);
            }
        }

        for (const [key, propSchema] of Object.entries(properties)) {
            if (!(key in value) || value[key] === undefined) continue;
            validateValue(value[key], propSchema, root, joinPath(path, key), errors, depth + 1, seenRefs);
        }

        if (resolved.additionalProperties === false) {
            for (const key of Object.keys(value)) {
                if (!(key in properties)) {
                    errors.push(`field '${joinPath(path, key)}' is not an allowed property`);
                }
            }
        } else if (resolved.additionalProperties && typeof resolved.additionalProperties === 'object') {
            for (const key of Object.keys(value)) {
                if (key in properties) continue;
                validateValue(value[key], resolved.additionalProperties, root, joinPath(path, key), errors, depth + 1, seenRefs);
            }
        }

        if (resolved.minProperties !== undefined && Object.keys(value).length < resolved.minProperties) {
            errors.push(`field '${path}' must have at least ${resolved.minProperties} properties`);
        }
        if (resolved.maxProperties !== undefined && Object.keys(value).length > resolved.maxProperties) {
            errors.push(`field '${path}' must have at most ${resolved.maxProperties} properties`);
        }
    }

    if (Array.isArray(resolved.allOf)) {
        for (const branch of resolved.allOf) {
            validateValue(value, branch, root, path, errors, depth + 1, seenRefs);
        }
    }

    if (Array.isArray(resolved.anyOf) && resolved.anyOf.length > 0) {
        const branchErrors: string[][] = resolved.anyOf.map(() => []);
        let matched = false;
        resolved.anyOf.forEach((branch: any, index: number) => {
            const local: string[] = [];
            validateValue(value, branch, root, path, local, depth + 1, seenRefs);
            branchErrors[index] = local;
            if (local.length === 0) matched = true;
        });
        if (!matched) {
            errors.push(`field '${path}' does not match any of the allowed schemas`);
        }
    }

    if (Array.isArray(resolved.oneOf) && resolved.oneOf.length > 0) {
        let matches = 0;
        for (const branch of resolved.oneOf) {
            const local: string[] = [];
            validateValue(value, branch, root, path, local, depth + 1, seenRefs);
            if (local.length === 0) matches++;
        }
        if (matches !== 1) {
            errors.push(`field '${path}' must match exactly one of the allowed schemas`);
        }
    }

    if (resolved.not !== undefined) {
        const local: string[] = [];
        validateValue(value, resolved.not, root, path, local, depth + 1, seenRefs);
        if (local.length === 0) {
            errors.push(`field '${path}' must not match the excluded schema`);
        }
    }
};

/**
 * Validate tool arguments against a tool's `inputSchema`.
 * @param args Arguments sent to the tool
 * @param schema The tool's input schema
 * @returns Array of error messages; empty means the arguments are valid
 */
export const validateArgs = (args: Record<string, unknown>, schema: any): string[] => {
    const errors: string[] = [];
    if (!schema || typeof schema !== 'object') return errors;
    validateValue(args ?? {}, schema, schema, '', errors, 0, new Set<string>());
    return errors;
};

/**
 * Validate a tool result against the tool's `outputSchema`.
 * Uses `structuredContent` when present, otherwise tries to parse the text content as JSON.
 * @param result The MCP tool result
 * @param schema The tool's output schema
 * @returns Array of error messages; empty means the result is valid (or not checkable)
 */
export const validateResult = (result: any, schema: any): string[] => {
    const errors: string[] = [];
    if (!schema || typeof schema !== 'object' || !result || typeof result !== 'object') return errors;

    let payload: any = undefined;
    let hasPayload = false;

    if (result.structuredContent !== undefined && result.structuredContent !== null) {
        payload = result.structuredContent;
        hasPayload = true;
    } else if (Array.isArray(result.content)) {
        for (const item of result.content) {
            if (item && item.type === 'text' && typeof item.text === 'string') {
                try {
                    payload = JSON.parse(item.text);
                    hasPayload = true;
                    break;
                } catch {
                    // not JSON: nothing structured to validate
                }
            }
        }
    }

    if (!hasPayload) return errors;
    validateValue(payload, schema, schema, '', errors, 0, new Set<string>());
    return errors;
};
