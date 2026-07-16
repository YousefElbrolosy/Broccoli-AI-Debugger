import * as http from 'node:http';
import * as vscode from 'vscode';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import type { DebugTools } from '../agent/DebugTools';
import { MCP_TOOLS } from '../agent/schemas';
import type { AgentState } from '../agent/AgentState';

const MCP_PATH = '/mcp';
/** MCP results go to another agent's context window — cap like the internal loop does. */
const MAX_RESULT_CHARS = 20_000;

export interface McpServerOptions {
    port: number;
    /** Empty string disables auth. */
    authToken: string;
}

/**
 * Streamable-HTTP MCP server hosted inside the extension host, exposing the
 * shared DebugTools surface to external MCP clients (Claude Code, Cursor, …).
 *
 * Stateless mode: a fresh Server + transport pair per POST, all delegating to
 * one shared DebugTools whose internal mutex serializes debugger operations.
 * Stop events are delivered through tool results (step/continue block until
 * the debuggee pauses), so no server→client notification stream is needed.
 */
export class McpDebugServer implements vscode.Disposable {
    private httpServer: http.Server | undefined;
    private requestCount = 0;

    constructor(
        private readonly tools: DebugTools,
        private readonly state: AgentState,
        private readonly output: vscode.OutputChannel
    ) {}

    get running(): boolean {
        return this.httpServer?.listening === true;
    }

    async start(opts: McpServerOptions): Promise<void> {
        if (this.running) {
            throw new Error('MCP server is already running.');
        }
        const { port, authToken } = opts;

        const server = http.createServer((req, res) => {
            this.handleHttp(req, res, opts).catch(e => {
                this.log(`request error: ${e instanceof Error ? e.message : String(e)}`);
                if (!res.headersSent) {
                    res.writeHead(500, { 'content-type': 'application/json' }).end(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            error: { code: -32603, message: 'Internal server error' },
                            id: null
                        })
                    );
                }
            });
        });

        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            // Loopback only — never expose the debugger to the network.
            server.listen(port, '127.0.0.1', () => {
                server.removeListener('error', reject);
                resolve();
            });
        });

        this.httpServer = server;
        this.requestCount = 0;
        this.publishStatus(port);
        this.log(
            `listening on http://127.0.0.1:${port}${MCP_PATH} (auth ${authToken ? 'ON' : 'off'})`
        );
    }

    async stop(): Promise<void> {
        const server = this.httpServer;
        this.httpServer = undefined;
        if (server) {
            await new Promise<void>(resolve => server.close(() => resolve()));
            this.log('stopped');
        }
        this.publishStatus(undefined);
    }

    dispose(): void {
        void this.stop();
    }

    private async handleHttp(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        opts: McpServerOptions
    ): Promise<void> {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${opts.port}`);
        if (url.pathname !== MCP_PATH) {
            res.writeHead(404).end('Not found. MCP endpoint: POST ' + MCP_PATH);
            return;
        }
        if (opts.authToken && req.headers.authorization !== `Bearer ${opts.authToken}`) {
            res.writeHead(401, { 'content-type': 'application/json' }).end(
                JSON.stringify({
                    jsonrpc: '2.0',
                    error: { code: -32001, message: 'Unauthorized: missing or invalid bearer token' },
                    id: null
                })
            );
            return;
        }

        this.requestCount++;
        this.publishStatus(opts.port);

        const server = this.buildMcpServer();
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableDnsRebindingProtection: true,
            allowedHosts: [
                '127.0.0.1',
                'localhost',
                `127.0.0.1:${opts.port}`,
                `localhost:${opts.port}`
            ]
        });
        res.on('close', () => {
            void transport.close();
            void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
    }

    private buildMcpServer(): Server {
        const server = new Server(
            { name: 'broccoli-debugger', version: '0.1.0' },
            { capabilities: { tools: {} } }
        );

        server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: MCP_TOOLS.map(t => ({
                name: t.name,
                description: t.description,
                inputSchema: t.input_schema as any
            }))
        }));

        server.setRequestHandler(CallToolRequestSchema, async request => {
            const name = request.params.name;
            const args = request.params.arguments ?? {};
            if (!MCP_TOOLS.some(t => t.name === name)) {
                return {
                    content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
                    isError: true
                };
            }
            this.log(`→ ${name} ${JSON.stringify(args)}`);
            const result = await this.tools.dispatch(name, args);
            this.log(`← ${name} ${result.isError ? '[error]' : '[ok]'}`);
            return {
                content: [{ type: 'text' as const, text: truncate(result.content, MAX_RESULT_CHARS) }],
                isError: result.isError === true
            };
        });

        return server;
    }

    private publishStatus(port: number | undefined): void {
        this.state.setMcp({
            running: this.running,
            port: this.running ? port : undefined,
            requestCount: this.requestCount,
            lastRequestAt: this.requestCount > 0 ? Date.now() : undefined
        });
    }

    private log(message: string): void {
        const ts = new Date().toLocaleTimeString();
        this.output.appendLine(`[${ts}] ${message}`);
    }
}

function truncate(s: string, max: number): string {
    if (s.length <= max) { return s; }
    return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}
