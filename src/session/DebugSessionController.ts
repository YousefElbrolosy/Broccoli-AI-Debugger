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

    constructor() {
        const trackerFactory: vscode.DebugAdapterTrackerFactory = {
            createDebugAdapterTracker: () => ({
                onDidSendMessage: (msg: any) => this.onDapMessage(msg)
            })
        };
        // '*' subscribes to every debug type
        this.disposables.push(
            vscode.debug.registerDebugAdapterTrackerFactory('*', trackerFactory),
            vscode.debug.onDidTerminateDebugSession(() => this.fanOut({ reason: 'terminated' }))
        );
    }

    private onDapMessage(msg: any) {
        if (msg?.type === 'event' && msg.event === 'stopped') {
            const body = msg.body ?? {};
            const evt: StopEvent = {
                reason: (body.reason ?? 'unknown') as StopReason,
                threadId: body.threadId,
                description: body.description,
                text: body.text,
                allThreadsStopped: body.allThreadsStopped
            };
            this.lastStop = evt;
            this.fanOut(evt);
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
