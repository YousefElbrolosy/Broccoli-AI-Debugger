import * as assert from 'assert';
import { looksLikeFixIntent, recoverToolCallFromText } from '../../agent/agentLoop';
import { sanitizeCall } from '../../agent/llm/openaiCompat';

suite('recoverToolCallFromText', () => {
    test('recovers a bare propose_code_fix payload', () => {
        const text = `Here is the fix:\n{"file":"/a.js","changes":[{"start_line":3,"start_char":0,"end_line":3,"end_char":10,"new_text":"x"}],"rationale":"off by one"}`;
        const call = recoverToolCallFromText(text);
        assert.strictEqual(call?.name, 'propose_code_fix');
        assert.strictEqual(call?.input.file, '/a.js');
    });

    test('recovers a bare finish payload', () => {
        const call = recoverToolCallFromText('{"summary":"the bug is X"}');
        assert.strictEqual(call?.name, 'finish');
        assert.strictEqual(call?.input.summary, 'the bug is X');
    });

    test('recovers an envelope with name+input for any known tool', () => {
        const call = recoverToolCallFromText(
            'I will step now: {"name":"step_over","input":{"timeout_ms":3000}}'
        );
        assert.strictEqual(call?.name, 'step_over');
        assert.deepStrictEqual(call?.input, { timeout_ms: 3000 });
    });

    test('recovers an envelope with tool+arguments', () => {
        const call = recoverToolCallFromText(
            '{"tool":"add_breakpoint","arguments":{"file":"/a.js","line":4}}'
        );
        assert.strictEqual(call?.name, 'add_breakpoint');
        assert.deepStrictEqual(call?.input, { file: '/a.js', line: 4 });
    });

    test('recovers an envelope with flattened arguments', () => {
        const call = recoverToolCallFromText('{"tool":"add_breakpoint","file":"/a.js","line":4}');
        assert.strictEqual(call?.name, 'add_breakpoint');
        assert.deepStrictEqual(call?.input, { file: '/a.js', line: 4 });
    });

    test('ignores unknown tool names and plain prose', () => {
        assert.strictEqual(recoverToolCallFromText('{"name":"rm_rf","input":{}}'), undefined);
        assert.strictEqual(recoverToolCallFromText('The bug is in line 3.'), undefined);
        assert.strictEqual(recoverToolCallFromText('{"broken json'), undefined);
    });
});

suite('looksLikeFixIntent', () => {
    test('detects diff blocks and prose fixes', () => {
        assert.ok(looksLikeFixIntent('```diff\n- a\n+ b\n```'));
        assert.ok(looksLikeFixIntent('--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@'));
        assert.ok(looksLikeFixIntent('My proposed fix is to change the loop.'));
        assert.ok(looksLikeFixIntent('- total += arr[i]\n+ total += arr[i] ?? 0'));
    });

    test('does not flag ordinary reasoning', () => {
        assert.ok(!looksLikeFixIntent('The variable i reaches 4, which is out of range.'));
    });
});

suite('sanitizeCall', () => {
    const known = new Set(['step_over', 'continue_execution']);

    test('passes clean calls through', () => {
        const { name, input } = sanitizeCall('step_over', '{"timeout_ms":100}', known);
        assert.strictEqual(name, 'step_over');
        assert.deepStrictEqual(input, { timeout_ms: 100 });
    });

    test('recovers name(args) malformations', () => {
        const { name, input } = sanitizeCall(
            'continue_execution({"timeout_ms":15000})',
            '',
            known
        );
        assert.strictEqual(name, 'continue_execution');
        assert.deepStrictEqual(input, { timeout_ms: 15000 });
    });

    test('prefixes unknown tools with INVALID__', () => {
        const { name } = sanitizeCall('made_up_tool', '{}', known);
        assert.ok(name.startsWith('INVALID__'));
    });

    test('keeps unparseable args as _raw', () => {
        const { input } = sanitizeCall('step_over', 'not json', known);
        assert.deepStrictEqual(input, { _raw: 'not json' });
    });
});
