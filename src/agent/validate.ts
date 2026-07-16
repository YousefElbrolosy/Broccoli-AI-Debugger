/**
 * Minimal JSON-Schema validator covering exactly the keywords used by the tool
 * schemas in schemas.ts: type, properties, required, minimum, minItems, items,
 * and nested objects. Returns human-readable problems (empty array = valid) so
 * a weak model gets a precise correction instead of a crash or silent clamp.
 */

export function validateToolInput(schema: any, input: unknown, path = 'input'): string[] {
    if (!schema || typeof schema !== 'object') {
        return [];
    }
    const problems: string[] = [];
    const type: string | undefined = schema.type;

    if (type === 'object') {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
            return [`${path} must be an object`];
        }
        const obj = input as Record<string, unknown>;
        for (const req of schema.required ?? []) {
            if (obj[req] === undefined || obj[req] === null) {
                problems.push(`${path}.${req} is required`);
            }
        }
        for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
            if (obj[key] !== undefined && obj[key] !== null) {
                problems.push(...validateToolInput(propSchema, obj[key], `${path}.${key}`));
            }
        }
        return problems;
    }

    if (type === 'array') {
        if (!Array.isArray(input)) {
            return [`${path} must be an array`];
        }
        if (typeof schema.minItems === 'number' && input.length < schema.minItems) {
            problems.push(`${path} must have at least ${schema.minItems} item(s)`);
        }
        if (schema.items) {
            input.forEach((item, i) => {
                problems.push(...validateToolInput(schema.items, item, `${path}[${i}]`));
            });
        }
        return problems;
    }

    if (type === 'string') {
        if (typeof input !== 'string') {
            return [`${path} must be a string`];
        }
        return problems;
    }

    if (type === 'integer' || type === 'number') {
        if (typeof input !== 'number' || !Number.isFinite(input)) {
            return [`${path} must be a number`];
        }
        if (type === 'integer' && !Number.isInteger(input)) {
            return [`${path} must be an integer`];
        }
        if (typeof schema.minimum === 'number' && input < schema.minimum) {
            problems.push(`${path} must be >= ${schema.minimum}`);
        }
        return problems;
    }

    if (type === 'boolean') {
        if (typeof input !== 'boolean') {
            return [`${path} must be a boolean`];
        }
        return problems;
    }

    return problems;
}
