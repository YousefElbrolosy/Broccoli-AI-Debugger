import * as vscode from 'vscode';

export type AgentRunStatus =
    | { kind: 'idle' }
    | { kind: 'running'; turn: number; maxTurns: number; toolName?: string }
    | { kind: 'done'; finished: boolean; turns: number; summary?: string };

export type NarrativeKind = 'thought' | 'rationale' | 'summary' | 'error';

export interface NarrativeEntry {
    kind: NarrativeKind;
    text: string;
    turn: number;
    /** Global ordering across narrative + tool events; assigned by AgentState. */
    seq?: number;
}

export interface ToolEvent {
    seq: number;
    turn: number;
    name: string;
    /** Compact rendering of the call arguments (≤ ~60 chars). */
    argsSummary: string;
    status: 'running' | 'ok' | 'error';
    /** Duration in ms, set when the call settles. */
    ms?: number;
}

export interface UsageTotals {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    turns: number;
    /** 0 = no budget configured. */
    tokenBudget: number;
}

export interface McpStatus {
    running: boolean;
    port?: number;
    /** Total tool/RPC requests served since start. */
    requestCount: number;
    /** ms since epoch of the most recent request, if any. */
    lastRequestAt?: number;
}

const EMPTY_USAGE: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    turns: 0,
    tokenBudget: 0
};

const MAX_NARRATIVE = 100;
const MAX_TOOL_EVENTS = 200;

/**
 * Singleton state shared by the agent loop, the MCP server and the sidebar GUI.
 * Holds run status, a rolling log of the model's prose output, the tool-call
 * timeline, token usage and MCP server status. One emitter for all of it.
 */
export class AgentState implements vscode.Disposable {
    private _status: AgentRunStatus = { kind: 'idle' };
    private _narrative: NarrativeEntry[] = [];
    private _toolEvents: ToolEvent[] = [];
    private _usage: UsageTotals = { ...EMPTY_USAGE };
    private _mcp: McpStatus = { running: false, requestCount: 0 };
    private seq = 0;
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onChange = this.emitter.event;

    get status(): AgentRunStatus {
        return this._status;
    }

    get narrative(): readonly NarrativeEntry[] {
        return this._narrative;
    }

    get toolEvents(): readonly ToolEvent[] {
        return this._toolEvents;
    }

    get usage(): UsageTotals {
        return this._usage;
    }

    get mcp(): McpStatus {
        return this._mcp;
    }

    set(status: AgentRunStatus): void {
        this._status = status;
        this.emitter.fire();
    }

    append(entry: NarrativeEntry): void {
        this._narrative.push({ ...entry, seq: ++this.seq });
        if (this._narrative.length > MAX_NARRATIVE) {
            this._narrative.splice(0, this._narrative.length - MAX_NARRATIVE);
        }
        this.emitter.fire();
    }

    /** Record a tool call starting; returns its seq for finishTool. */
    startTool(turn: number, name: string, argsSummary: string): number {
        const seq = ++this.seq;
        this._toolEvents.push({ seq, turn, name, argsSummary, status: 'running' });
        if (this._toolEvents.length > MAX_TOOL_EVENTS) {
            this._toolEvents.splice(0, this._toolEvents.length - MAX_TOOL_EVENTS);
        }
        this.emitter.fire();
        return seq;
    }

    finishTool(seq: number, status: 'ok' | 'error', ms: number): void {
        const evt = this._toolEvents.find(e => e.seq === seq);
        if (evt) {
            evt.status = status;
            evt.ms = ms;
            this.emitter.fire();
        }
    }

    addUsage(delta: Partial<UsageTotals>): void {
        this._usage = {
            ...this._usage,
            inputTokens: this._usage.inputTokens + (delta.inputTokens ?? 0),
            outputTokens: this._usage.outputTokens + (delta.outputTokens ?? 0),
            cacheReadTokens: this._usage.cacheReadTokens + (delta.cacheReadTokens ?? 0),
            cacheWriteTokens: this._usage.cacheWriteTokens + (delta.cacheWriteTokens ?? 0),
            turns: delta.turns ?? this._usage.turns,
            tokenBudget: delta.tokenBudget ?? this._usage.tokenBudget
        };
        this.emitter.fire();
    }

    resetUsage(tokenBudget: number): void {
        this._usage = { ...EMPTY_USAGE, tokenBudget };
        this.emitter.fire();
    }

    setMcp(status: McpStatus): void {
        this._mcp = status;
        this.emitter.fire();
    }

    clearNarrative(): void {
        this._narrative = [];
        this._toolEvents = [];
        this.emitter.fire();
    }

    dispose() {
        this.emitter.dispose();
    }
}
