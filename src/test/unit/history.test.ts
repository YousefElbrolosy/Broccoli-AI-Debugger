import * as assert from 'assert';
import { compactHistory, estimateChars } from '../../agent/history';
import type { NormalizedMessage } from '../../agent/llm/types';

function toolTurn(id: string, name: string, resultChars: number, isError = false): NormalizedMessage[] {
    return [
        { role: 'assistant', toolCalls: [{ id, name, input: {} }] },
        { role: 'tool', toolCallId: id, content: JSON.stringify({ data: 'x'.repeat(resultChars) }), isError }
    ];
}

suite('compactHistory', () => {
    test('keeps the most recent N tool results verbatim', () => {
        const messages: NormalizedMessage[] = [
            { role: 'user', content: 'find the bug' },
            ...toolTurn('t1', 'step_over', 500),
            ...toolTurn('t2', 'step_over', 500),
            ...toolTurn('t3', 'inspect_variables', 500),
            ...toolTurn('t4', 'step_over', 500)
        ];
        const { messages: out, pruned } = compactHistory(messages, { keepRecentToolResults: 2 });
        assert.strictEqual(pruned, 2);
        const tools = out.filter(m => m.role === 'tool') as Extract<NormalizedMessage, { role: 'tool' }>[];
        assert.ok(tools[0].content.includes('"pruned":true'), 't1 pruned');
        assert.ok(tools[1].content.includes('"pruned":true'), 't2 pruned');
        assert.ok(!tools[2].content.includes('"pruned":true'), 't3 kept');
        assert.ok(!tools[3].content.includes('"pruned":true'), 't4 kept');
    });

    test('never prunes errors or propose_code_fix/finish results', () => {
        const messages: NormalizedMessage[] = [
            { role: 'user', content: 'go' },
            ...toolTurn('t1', 'propose_code_fix', 500),
            ...toolTurn('t2', 'step_over', 500, true),
            ...toolTurn('t3', 'step_over', 500),
            ...toolTurn('t4', 'step_over', 500)
        ];
        const { messages: out, pruned } = compactHistory(messages, { keepRecentToolResults: 1 });
        assert.strictEqual(pruned, 1); // only t3
        const tools = out.filter(m => m.role === 'tool') as Extract<NormalizedMessage, { role: 'tool' }>[];
        assert.ok(!tools[0].content.includes('"pruned":true'), 'propose_code_fix kept');
        assert.ok(!tools[1].content.includes('"pruned":true'), 'error kept');
        assert.ok(tools[2].content.includes('"pruned":true'), 'plain old result pruned');
    });

    test('is a no-op when everything fits in the keep window', () => {
        const messages: NormalizedMessage[] = [
            { role: 'user', content: 'go' },
            ...toolTurn('t1', 'step_over', 100)
        ];
        const { pruned, savedChars } = compactHistory(messages, { keepRecentToolResults: 6 });
        assert.strictEqual(pruned, 0);
        assert.strictEqual(savedChars, 0);
    });

    test('is idempotent (stubs are not re-pruned)', () => {
        const messages: NormalizedMessage[] = [
            { role: 'user', content: 'go' },
            ...toolTurn('t1', 'step_over', 500),
            ...toolTurn('t2', 'step_over', 500),
            ...toolTurn('t3', 'step_over', 500)
        ];
        const first = compactHistory(messages, { keepRecentToolResults: 1 });
        const second = compactHistory(first.messages, { keepRecentToolResults: 1 });
        assert.strictEqual(second.pruned, 0);
    });

    test('estimateChars counts user, assistant and tool content', () => {
        const messages: NormalizedMessage[] = [
            { role: 'user', content: 'abcd' },
            { role: 'assistant', text: 'ef', toolCalls: [{ id: 'x', name: 'finish', input: { summary: 'hi' } }] },
            { role: 'tool', toolCallId: 'x', content: '{"a":1}', isError: false }
        ];
        assert.ok(estimateChars(messages) >= 4 + 2 + 'finish'.length + 7);
    });

    test('compaction actually shrinks the estimate', () => {
        const messages: NormalizedMessage[] = [
            { role: 'user', content: 'go' },
            ...toolTurn('t1', 'step_over', 5000),
            ...toolTurn('t2', 'step_over', 5000),
            ...toolTurn('t3', 'step_over', 50)
        ];
        const before = estimateChars(messages);
        const { messages: out, savedChars } = compactHistory(messages, { keepRecentToolResults: 1 });
        const after = estimateChars(out);
        assert.ok(after < before, `after=${after} before=${before}`);
        assert.ok(savedChars > 8000, `savedChars=${savedChars}`);
    });
});
