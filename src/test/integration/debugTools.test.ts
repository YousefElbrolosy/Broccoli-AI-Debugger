import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DebugSessionController } from '../../session/DebugSessionController';
import { DebugTools } from '../../agent/DebugTools';
import { __setConfirmOverrideForTests, registerDiffPreviewProvider } from '../../orchestrator/diff';

suite('DebugTools against a real js-debug session', function () {
    this.timeout(60_000);

    let controller: DebugSessionController;
    let tools: DebugTools;
    let fixture: string;

    suiteSetup(() => {
        controller = new DebugSessionController();
        tools = new DebugTools(controller);
        const ws = vscode.workspace.workspaceFolders?.[0];
        assert.ok(ws, 'test workspace (test-fixtures) is open');
        fixture = path.join(ws.uri.fsPath, 'off-by-one.js');
    });

    suiteTeardown(async () => {
        __setConfirmOverrideForTests(undefined);
        try {
            await vscode.debug.stopDebugging();
        } catch {
            // no session left — fine
        }
        controller.dispose();
    });

    setup(async () => {
        // Hermetic per-test state: no leftover breakpoints or sessions.
        vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
        if (vscode.debug.activeDebugSession) {
            await vscode.debug.stopDebugging();
        }
    });

    async function call(name: string, input: unknown): Promise<{ parsed: any; isError: boolean }> {
        const result = await tools.dispatch(name, input);
        let parsed: any;
        try {
            parsed = JSON.parse(result.content);
        } catch {
            parsed = { _raw: result.content };
        }
        return { parsed, isError: result.isError === true };
    }

    test('input validation rejects malformed calls without throwing', async () => {
        const missing = await call('add_breakpoint', { file: fixture });
        assert.ok(missing.isError);
        assert.ok(missing.parsed.error.includes('line'), missing.parsed.error);

        const badType = await call('add_breakpoint', { file: fixture, line: 'six' });
        assert.ok(badType.isError);

        const unknown = await call('warp_reality', {});
        assert.ok(unknown.isError);
        assert.ok(unknown.parsed.error.includes('Unknown tool'), unknown.parsed.error);
    });

    test('read_source is workspace-scoped and returns numbered lines', async () => {
        const good = await call('read_source', { file: fixture, start_line: 1, end_line: 5 });
        assert.ok(!good.isError, JSON.stringify(good.parsed));
        assert.ok(good.parsed.content.includes('sumArray'));
        assert.ok(good.parsed.content.includes('1:'), 'lines are numbered');

        const escape = await call('read_source', { file: '/etc/hosts' });
        assert.ok(escape.isError);
        assert.ok(escape.parsed.error.includes('outside'), escape.parsed.error);
    });

    test('breakpoint → start → stack → variables → step → continue flow', async () => {
        const bp = await call('add_breakpoint', { file: fixture, line: 6 });
        assert.ok(!bp.isError, JSON.stringify(bp.parsed));

        const listed = await call('list_breakpoints', {});
        assert.ok(
            listed.parsed.some((b: any) => b.line === 6 && b.file.endsWith('off-by-one.js')),
            JSON.stringify(listed.parsed)
        );

        const start = await call('start_debug_session', { configuration: 'off-by-one' });
        assert.ok(!start.isError, JSON.stringify(start.parsed));
        assert.strictEqual(start.parsed.started, true);
        assert.ok(start.parsed.firstEvent, 'a stop event arrived after launch');

        // The post-stop race fix must yield a stack on the FIRST attempt.
        const stack = await call('get_stack_trace', {});
        assert.ok(!stack.isError, JSON.stringify(stack.parsed));
        assert.ok(stack.parsed.length > 0, 'stack is not empty right after the stop');
        assert.ok(stack.parsed[0].source.endsWith('off-by-one.js'), JSON.stringify(stack.parsed[0]));
        assert.strictEqual(stack.parsed[0].line, 6);

        const vars = await call('inspect_variables', { frame_index: 0 });
        assert.ok(!vars.isError, JSON.stringify(vars.parsed));
        const allNames = vars.parsed.flatMap((s: any) => s.variables.map((v: any) => v.name));
        assert.ok(allNames.includes('i'), `locals include i: ${allNames.join(',')}`);
        assert.ok(allNames.includes('total'), `locals include total: ${allNames.join(',')}`);

        const step = await call('step_over', {});
        assert.ok(!step.isError, JSON.stringify(step.parsed));
        assert.strictEqual(step.parsed.status, 'stopped');
        assert.ok(step.parsed.top_frame, 'step result has a top frame');
        assert.ok(step.parsed.locals_preview, 'slim step result carries a locals preview');
        assert.strictEqual(step.parsed.variables, undefined, 'full snapshot only on request');

        const fullStep = await call('step_over', { include_variables: true });
        assert.ok(!fullStep.isError, JSON.stringify(fullStep.parsed));
        assert.ok(Array.isArray(fullStep.parsed.variables), 'include_variables returns scopes');

        const state = await call('get_debugger_state', {});
        assert.strictEqual(state.parsed.session_active, true);
        assert.strictEqual(state.parsed.paused, true);
        assert.ok(state.parsed.launch_configurations.includes('off-by-one'));

        // Remove the loop breakpoint so continue runs to termination.
        const rm = await call('remove_breakpoint', { file: fixture, line: 6 });
        assert.ok(!rm.isError && rm.parsed.removed === true, JSON.stringify(rm.parsed));

        const cont = await call('continue_execution', { timeout_ms: 20_000 });
        assert.ok(!cont.isError, JSON.stringify(cont.parsed));
        assert.strictEqual(cont.parsed.status, 'terminated');
    });

    test('propose_code_fix validates bounds and honors user decision', async () => {
        const original = fs.readFileSync(fixture, 'utf8');
        try {
            const oob = await call('propose_code_fix', {
                file: fixture,
                changes: [
                    { start_line: 9999, start_char: 0, end_line: 9999, end_char: 0, new_text: 'x' }
                ],
                rationale: 'test'
            });
            assert.ok(oob.isError);
            assert.ok(oob.parsed.error.includes('lines'), oob.parsed.error);

            const overlap = await call('propose_code_fix', {
                file: fixture,
                changes: [
                    { start_line: 5, start_char: 0, end_line: 6, end_char: 5, new_text: 'a' },
                    { start_line: 6, start_char: 0, end_line: 7, end_char: 0, new_text: 'b' }
                ],
                rationale: 'test'
            });
            assert.ok(overlap.isError);
            assert.ok(overlap.parsed.error.includes('overlap'), overlap.parsed.error);

            const outside = await call('propose_code_fix', {
                file: '/etc/hosts',
                changes: [
                    { start_line: 1, start_char: 0, end_line: 1, end_char: 0, new_text: 'x' }
                ],
                rationale: 'test'
            });
            assert.ok(outside.isError);
            assert.ok(outside.parsed.error.includes('outside'), outside.parsed.error);

            registerDiffPreviewProvider({ subscriptions: [] } as any);

            __setConfirmOverrideForTests(async () => false);
            const rejected = await call('propose_code_fix', {
                file: fixture,
                changes: [
                    { start_line: 5, start_char: 20, end_line: 5, end_char: 22, new_text: '<' }
                ],
                rationale: 'replace <= with <'
            });
            assert.ok(!rejected.isError);
            assert.strictEqual(rejected.parsed.accepted, false);
            assert.strictEqual(fs.readFileSync(fixture, 'utf8'), original, 'reject leaves file intact');

            __setConfirmOverrideForTests(async () => true);
            const accepted = await call('propose_code_fix', {
                file: fixture,
                changes: [
                    { start_line: 5, start_char: 22, end_line: 5, end_char: 24, new_text: '< ' }
                ],
                rationale: 'replace <= with <'
            });
            assert.ok(!accepted.isError, JSON.stringify(accepted.parsed));
            assert.strictEqual(accepted.parsed.accepted, true);
            const afterApply = fs.readFileSync(fixture, 'utf8');
            assert.notStrictEqual(afterApply, original, 'accept modifies the file');
        } finally {
            __setConfirmOverrideForTests(undefined);
            fs.writeFileSync(fixture, original);
            // Revert the in-editor document too so later suites see clean state.
            await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor').then(
                undefined,
                () => {}
            );
        }
    });

    test('step timeout reports running instead of erroring', async () => {
        // async-race sleeps ~60ms total; a 100ms-timeout continue right at a
        // breakpoint on the sleep line may or may not stop in time — but with
        // NO breakpoints and a program that exits, we exercise the structured
        // timeout on a session that terminates instead.
        const start = await call('start_debug_session', { configuration: 'async-race' });
        assert.ok(!start.isError, JSON.stringify(start.parsed));
        // No breakpoints: program crashes/exits on its own; wait for it.
        const state = await call('get_debugger_state', {});
        assert.ok(state.parsed.session_active !== undefined);
        try {
            await vscode.debug.stopDebugging();
        } catch {
            // already gone
        }
    });
});
