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
}

const MAX_NARRATIVE = 100;

/**
 * Singleton state shared by the agent loop and the sidebar GUI.
 * Holds run status + a rolling log of the model's prose output (thoughts,
 * fix rationales, final summaries, errors). One emitter for both.
 */
export class AgentState implements vscode.Disposable {
    private _status: AgentRunStatus = { kind: 'idle' };
    private _narrative: NarrativeEntry[] = [];
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onChange = this.emitter.event;

    get status(): AgentRunStatus {
        return this._status;
    }

    get narrative(): readonly NarrativeEntry[] {
        return this._narrative;
    }

    set(status: AgentRunStatus): void {
        this._status = status;
        this.emitter.fire();
    }

    append(entry: NarrativeEntry): void {
        this._narrative.push(entry);
        if (this._narrative.length > MAX_NARRATIVE) {
            this._narrative.splice(0, this._narrative.length - MAX_NARRATIVE);
        }
        this.emitter.fire();
    }

    clearNarrative(): void {
        this._narrative = [];
        this.emitter.fire();
    }

    dispose() {
        this.emitter.dispose();
    }
}
