import * as vscode from 'vscode';

export type StopReason =
    | 'breakpoint'
    | 'step'
    | 'exception'
    | 'pause'
    | 'entry'
    | 'goto'
    | 'function breakpoint'
    | 'data breakpoint'
    | 'unknown';

export interface StopEvent {
    reason: StopReason;
    threadId?: number;
    description?: string;
    text?: string;
    allThreadsStopped?: boolean;
}

export type SessionEnd = { reason: 'terminated' };

export class NoActiveDebugSessionError extends Error {
    constructor() {
        super('No active debug session');
        this.name = 'NoActiveDebugSessionError';
    }
}

export class DebugTimeoutError extends Error {
    constructor(ms: number) {
        super(`Timed out after ${ms}ms waiting for debugger`);
        this.name = 'DebugTimeoutError';
    }
}

type Waiter = {
    resolve: (e: StopEvent | SessionEnd) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
};

/**
 * Owns debug-session lifecycle and turns DAP events into awaitable promises.
 * One controller per extension activation.
 */
export class DebugSessionController implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private waiters: Waiter[] = [];
    private lastStop: StopEvent | undefined;
    private seq = 0;

    private _paused = false;
    private lastStopSession: vscode.DebugSession | undefined;

    constructor() {
        const trackerFactory: vscode.DebugAdapterTrackerFactory = {
            createDebugAdapterTracker: (session: vscode.DebugSession) => ({
                onDidSendMessage: (msg: any) => this.onDapMessage(session, msg),
                onWillReceiveMessage: (msg: any) => this.onDapRequest(msg)
            })
        };
        // '*' subscribes to every debug type
        this.disposables.push(
            vscode.debug.registerDebugAdapterTrackerFactory('*', trackerFactory),
            vscode.debug.onDidTerminateDebugSession(session => {
                this._paused = false;
                if (this.lastStopSession === session) {
                    this.lastStopSession = undefined;
                }
                this.fanOut({ reason: 'terminated' });
            })
        );
    }

    private onDapMessage(session: vscode.DebugSession, msg: any) {
        if (msg?.type !== 'event') { return; }
        if (msg.event === 'stopped') {
            const body = msg.body ?? {};
            const evt: StopEvent = {
                reason: (body.reason ?? 'unknown') as StopReason,
                threadId: body.threadId,
                description: body.description,
                text: body.text,
                allThreadsStopped: body.allThreadsStopped
            };
            this.lastStop = evt;
            this.lastStopSession = session;
            this.seq++;
            this._paused = true;
            this.fanOut(evt);
        } else if (msg.event === 'continued') {
            this._paused = false;
        }
    }

    private onDapRequest(msg: any) {
        // Requests VS Code sends to the adapter: a resume request means we're
        // no longer paused (some adapters don't emit `continued` events).
        if (
            msg?.type === 'request' &&
            ['continue', 'next', 'stepIn', 'stepOut', 'restart'].includes(msg.command)
        ) {
            this._paused = false;
        }
    }

    private fanOut(evt: StopEvent | SessionEnd) {
        const pending = this.waiters;
        this.waiters = [];
        for (const w of pending) {
            clearTimeout(w.timer);
            w.resolve(evt);
        }
    }

    public get session(): vscode.DebugSession | undefined {
        return vscode.debug.activeDebugSession;
    }

    /**
     * The session DAP requests should target. js-debug (and other compound
     * adapters) run a parent session that does not answer requests like
     * `stackTrace` — prefer the session that actually emitted the last
     * `stopped` event over whatever VS Code considers "active".
     */
    public get dapSession(): vscode.DebugSession | undefined {
        return this.lastStopSession ?? vscode.debug.activeDebugSession;
    }

    public get topFrameId(): number | undefined {
        const s = vscode.debug.activeStackItem;
        if (s && 'frameId' in s) {
            return (s as vscode.DebugStackFrame).frameId;
        }
        return undefined;
    }

    public get lastStopEvent(): StopEvent | undefined {
        return this.lastStop;
    }

    /** Monotonic counter of `stopped` events; lets callers detect a stop that landed after their waiter timed out. */
    public get stopSeq(): number {
        return this.seq;
    }

    /** Best-effort "is the debuggee paused" derived from DAP traffic. */
    public get paused(): boolean {
        return this._paused && !!vscode.debug.activeDebugSession;
    }

    /**
     * Resolve on the next `stopped` DAP event or session termination.
     * Reject on timeout.
     */
    public waitForStop(timeoutMs: number): Promise<StopEvent | SessionEnd> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiters = this.waiters.filter(w => w.timer !== timer);
                reject(new DebugTimeoutError(timeoutMs));
            }, timeoutMs);
            this.waiters.push({ resolve, reject, timer });
        });
    }

    public requireSession(): vscode.DebugSession {
        const s = vscode.debug.activeDebugSession;
        if (!s) {
            throw new NoActiveDebugSessionError();
        }
        return s;
    }

    public dispose() {
        for (const w of this.waiters) {
            clearTimeout(w.timer);
        }
        this.waiters = [];
        this.disposables.forEach(d => d.dispose());
    }
}
