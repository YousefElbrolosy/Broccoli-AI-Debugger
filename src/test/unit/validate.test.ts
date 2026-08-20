import * as assert from 'assert';
import { validateToolInput } from '../../agent/validate';
import { TOOLS } from '../../agent/schemas';

function schemaOf(name: string): any {
    const t = TOOLS.find(t => t.name === name);
    assert.ok(t, `schema for ${name} exists`);
    return t!.input_schema;
}

suite('validateToolInput', () => {
    test('accepts valid input for every tool schema', () => {
        const valid: Record<string, unknown> = {
            start_debug_session: { configuration: 'off-by-one' },
            add_breakpoint: { file: '/a/b.js', line: 3, condition: 'x > 1' },
            remove_breakpoint: { file: '/a/b.js', line: 3 },
            list_breakpoints: {},
            continue_execution: { timeout_ms: 500, include_variables: true },
            step_over: {},
            step_into: { timeout_ms: 100 },
            step_out: { include_variables: false },
            inspect_variables: { frame_index: 0 },
            expand_variable: { variables_reference: 12 },
            get_stack_trace: {},
            read_source: { file: '/a/b.js', start_line: 1, end_line: 10 },
            restart_debug_session: {},
            stop_debug_session: {},
            propose_code_fix: {
                file: '/a/b.js',
                changes: [
                    { start_line: 1, start_char: 0, end_line: 1, end_char: 5, new_text: 'x' }
                ],
                rationale: 'because'
            },
            get_debugger_state: {},
            finish: { summary: 'done' }
        };
        for (const t of TOOLS) {
            assert.ok(t.name in valid, `test covers ${t.name}`);
            const problems = validateToolInput(t.input_schema, valid[t.name]);
            assert.deepStrictEqual(problems, [], `${t.name}: ${problems.join('; ')}`);
        }
    });

    test('rejects missing required properties', () => {
        assert.ok(validateToolInput(schemaOf('add_breakpoint'), { file: '/a.js' }).length > 0);
        assert.ok(validateToolInput(schemaOf('finish'), {}).length > 0);
        assert.ok(validateToolInput(schemaOf('read_source'), {}).length > 0);
    });

    test('rejects wrong types with a readable message', () => {
        const problems = validateToolInput(schemaOf('add_breakpoint'), {
            file: 42,
            line: 'three'
        });
        assert.ok(problems.some(p => p.includes('file') && p.includes('string')), problems.join(';'));
        assert.ok(problems.some(p => p.includes('line')), problems.join(';'));
    });

    test('enforces minimum and integer', () => {
        assert.ok(
            validateToolInput(schemaOf('add_breakpoint'), { file: '/a.js', line: 0 }).some(p =>
                p.includes('>= 1')
            )
        );
        assert.ok(
            validateToolInput(schemaOf('add_breakpoint'), { file: '/a.js', line: 1.5 }).some(p =>
                p.includes('integer')
            )
        );
        assert.ok(
            validateToolInput(schemaOf('continue_execution'), { timeout_ms: 50 }).some(p =>
                p.includes('>= 100')
            )
        );
    });

    test('validates nested array items', () => {
        const problems = validateToolInput(schemaOf('propose_code_fix'), {
            file: '/a.js',
            changes: [{ start_line: 1, start_char: 0, end_line: 1 }],
            rationale: 'x'
        });
        assert.ok(problems.some(p => p.includes('changes[0]')), problems.join('; '));
    });

    test('rejects empty changes array (minItems)', () => {
        const problems = validateToolInput(schemaOf('propose_code_fix'), {
            file: '/a.js',
            changes: [],
            rationale: 'x'
        });
        assert.ok(problems.some(p => p.includes('at least 1')), problems.join('; '));
    });

    test('rejects non-object input for object schemas', () => {
        assert.ok(validateToolInput(schemaOf('finish'), 'just text').length > 0);
        assert.ok(validateToolInput(schemaOf('finish'), [1, 2]).length > 0);
    });
});
