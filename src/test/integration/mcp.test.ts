import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DebugSessionController } from '../../session/DebugSessionController';
import { DebugTools } from '../../agent/DebugTools';
import { AgentState } from '../../agent/AgentState';
import { McpDebugServer } from '../../mcp/server';

const PORT = 4931;
const TOKEN = 'broccoli-test-token';

suite('MCP server end-to-end over Streamable HTTP', function () {
    this.timeout(60_000);

    let controller: DebugSessionController;
    let state: AgentState;
    let server: McpDebugServer;
    let client: Client | undefined;
    let fixture: string;

    suiteSetup(async () => {
        controller = new DebugSessionController();
        state = new AgentState();
        const output = vscode.window.createOutputChannel('Broccoli MCP (test)');
        server = new McpDebugServer(new DebugTools(controller), state, output);
        await server.start({ port: PORT, authToken: TOKEN });
        const ws = vscode.workspace.workspaceFolders?.[0];
        assert.ok(ws, 'test workspace (test-fixtures) is open');
        fixture = path.join(ws.uri.fsPath, 'off-by-one.js');
    });

    suiteTeardown(async () => {
        await client?.close().catch(() => {});
        await server.stop();
        try {
            await vscode.debug.stopDebugging();
        } catch {
            // no session left
        }
        controller.dispose();
        state.dispose();
    });

    test('rejects requests without the bearer token', async () => {
        const resp = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream'
            },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 })
        });
        assert.strictEqual(resp.status, 401);
    });

    test('unknown paths 404', async () => {
        const resp = await fetch(`http://127.0.0.1:${PORT}/other`, { method: 'POST' });
        assert.strictEqual(resp.status, 404);
    });

    async function connect(): Promise<Client> {
        const c = new Client({ name: 'broccoli-test-client', version: '0.0.1' });
        const transport = new StreamableHTTPClientTransport(
            new URL(`http://127.0.0.1:${PORT}/mcp`),
            { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }
        );
        await c.connect(transport);
        return c;
    }

    function textOf(result: any): any {
        const text = result.content?.[0]?.text;
        assert.ok(typeof text === 'string', JSON.stringify(result));
        return JSON.parse(text);
    }

    test('lists the debugger tool surface (no finish, has get_debugger_state)', async () => {
        client = await connect();
        const { tools } = await client.listTools();
        const names = tools.map(t => t.name);
        assert.ok(names.includes('start_debug_session'), names.join(','));
        assert.ok(names.includes('get_debugger_state'), names.join(','));
        assert.ok(names.includes('propose_code_fix'), names.join(','));
        assert.ok(!names.includes('finish'), 'finish is not exposed over MCP');
        for (const t of tools) {
            assert.ok(t.inputSchema, `${t.name} has an input schema`);
        }
    });

    test('drives a real debug session over HTTP', async () => {
        client = client ?? (await connect());

        const orient = textOf(await client.callTool({ name: 'get_debugger_state', arguments: {} }));
        assert.strictEqual(orient.session_active, false);
        assert.ok(orient.launch_configurations.includes('off-by-one'));

        const src = textOf(
            await client.callTool({
                name: 'read_source',
                arguments: { file: fixture, start_line: 1, end_line: 8 }
            })
        );
        assert.ok(src.content.includes('sumArray'));

        textOf(
            await client.callTool({
                name: 'add_breakpoint',
                arguments: { file: fixture, line: 6 }
            })
        );

        const started = textOf(
            await client.callTool({
                name: 'start_debug_session',
                arguments: { configuration: 'off-by-one' }
            })
        );
        assert.strictEqual(started.started, true);

        const stack = textOf(await client.callTool({ name: 'get_stack_trace', arguments: {} }));
        assert.ok(stack.length > 0);
        assert.strictEqual(stack[0].line, 6);

        const step = textOf(await client.callTool({ name: 'step_over', arguments: {} }));
        assert.strictEqual(step.status, 'stopped');

        textOf(
            await client.callTool({
                name: 'remove_breakpoint',
                arguments: { file: fixture, line: 6 }
            })
        );
        const cont = textOf(
            await client.callTool({
                name: 'continue_execution',
                arguments: { timeout_ms: 20000 }
            })
        );
        assert.strictEqual(cont.status, 'terminated');
    });

    test('invalid tool input surfaces as isError, not a transport failure', async () => {
        client = client ?? (await connect());
        const result: any = await client.callTool({
            name: 'add_breakpoint',
            arguments: { file: fixture }
        });
        assert.strictEqual(result.isError, true);
        assert.ok(String(result.content?.[0]?.text).includes('line'));
    });
});
