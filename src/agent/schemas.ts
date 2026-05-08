import type { ToolSchema } from './llm/types';

export type ToolName =
    | 'start_debug_session'
    | 'add_breakpoint'
    | 'remove_breakpoint'
    | 'list_breakpoints'
    | 'continue_execution'
    | 'step_over'
    | 'step_into'
    | 'step_out'
    | 'inspect_variables'
    | 'expand_variable'
    | 'get_stack_trace'
    | 'read_source'
    | 'restart_debug_session'
    | 'stop_debug_session'
    | 'propose_code_fix'
    | 'finish';

export const TOOLS: ToolSchema[] = [
    {
        name: 'start_debug_session',
        description:
            'Start a VS Code debug session using the workspace launch.json. Use only when no session is active. Returns session metadata once attached.',
        input_schema: { type: 'object', properties: {} }
    },
    {
        name: 'add_breakpoint',
        description:
            'Add a source breakpoint. Can be set before or during a session. Use a conditional expression to break only when relevant.',
        input_schema: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'Absolute file path.' },
                line: { type: 'integer', minimum: 1, description: '1-indexed line number.' },
                condition: {
                    type: 'string',
                    description: 'Optional break condition (e.g. "x > 10").'
                }
            },
            required: ['file', 'line']
        }
    },
    {
        name: 'remove_breakpoint',
        description: 'Remove a source breakpoint at a given file:line.',
        input_schema: {
            type: 'object',
            properties: {
                file: { type: 'string' },
                line: { type: 'integer', minimum: 1 }
            },
            required: ['file', 'line']
        }
    },
    {
        name: 'list_breakpoints',
        description: 'List all currently registered source breakpoints.',
        input_schema: { type: 'object', properties: {} }
    },
    {
        name: 'continue_execution',
        description:
            'Resume execution. Returns the next stop reason ("breakpoint" | "step" | "exception" | "terminated") and the new top frame, if any. Blocks up to a timeout.',
        input_schema: {
            type: 'object',
            properties: {
                timeout_ms: { type: 'integer', minimum: 100, default: 15000 }
            }
        }
    },
    {
        name: 'step_over',
        description:
            'Step over the current line. Returns the next stop reason and top frame.',
        input_schema: {
            type: 'object',
            properties: {
                timeout_ms: { type: 'integer', minimum: 100, default: 5000 }
            }
        }
    },
    {
        name: 'step_into',
        description: 'Step into the function call on the current line.',
        input_schema: {
            type: 'object',
            properties: {
                timeout_ms: { type: 'integer', minimum: 100, default: 5000 }
            }
        }
    },
    {
        name: 'step_out',
        description: 'Step out of the current function.',
        input_schema: {
            type: 'object',
            properties: {
                timeout_ms: { type: 'integer', minimum: 100, default: 5000 }
            }
        }
    },
    {
        name: 'inspect_variables',
        description:
            'Inspect variables in a stack frame. Defaults to the top frame. Nested objects are summarized; pass their variables_reference to expand_variable to drill deeper.',
        input_schema: {
            type: 'object',
            properties: {
                frame_index: {
                    type: 'integer',
                    minimum: 0,
                    description:
                        '0-based index into the call stack returned by get_stack_trace. 0 = top (most recent) frame. Default: 0.'
                }
            }
        }
    },
    {
        name: 'expand_variable',
        description:
            'Expand a nested variable by its variables_reference (obtained from inspect_variables).',
        input_schema: {
            type: 'object',
            properties: {
                variables_reference: { type: 'integer', minimum: 1 }
            },
            required: ['variables_reference']
        }
    },
    {
        name: 'get_stack_trace',
        description: 'Return the current call stack of the paused thread.',
        input_schema: { type: 'object', properties: {} }
    },
    {
        name: 'read_source',
        description:
            'Read a source file from the open workspace. Use this to view code (e.g. to decide where to set a breakpoint). Returns numbered lines. Use start_line/end_line for files larger than ~500 lines. This is the only way to view source — there is no expression evaluator.',
        input_schema: {
            type: 'object',
            properties: {
                file: {
                    type: 'string',
                    description: 'Absolute path within an open workspace folder.'
                },
                start_line: {
                    type: 'integer',
                    minimum: 1,
                    description: '1-indexed inclusive start line. Default: 1.'
                },
                end_line: {
                    type: 'integer',
                    minimum: 1,
                    description: '1-indexed inclusive end line. Default: end of file.'
                }
            },
            required: ['file']
        }
    },
    {
        name: 'restart_debug_session',
        description: 'Restart the active debug session.',
        input_schema: { type: 'object', properties: {} }
    },
    {
        name: 'stop_debug_session',
        description: 'Terminate the active debug session.',
        input_schema: { type: 'object', properties: {} }
    },
    {
        name: 'propose_code_fix',
        description:
            'Propose a code edit. The user is shown a diff and decides whether to apply. Use only when you have evidence (variable observation, stack trace) for the root cause. Lines are 1-indexed (matching read_source output); columns are 0-indexed. The range is inclusive in line numbers and half-open in columns: replacing line N entirely is start_line=N, start_char=0, end_line=N, end_char=<beyond end of line is fine>.',
        input_schema: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'Absolute file path.' },
                changes: {
                    type: 'array',
                    minItems: 1,
                    items: {
                        type: 'object',
                        properties: {
                            start_line: {
                                type: 'integer',
                                minimum: 1,
                                description: '1-indexed start line, matching the numbers shown by read_source.'
                            },
                            start_char: { type: 'integer', minimum: 0, description: '0-indexed column.' },
                            end_line: {
                                type: 'integer',
                                minimum: 1,
                                description: '1-indexed end line. To replace just line N, use end_line = N.'
                            },
                            end_char: { type: 'integer', minimum: 0, description: '0-indexed column.' },
                            new_text: { type: 'string' }
                        },
                        required: ['start_line', 'start_char', 'end_line', 'end_char', 'new_text']
                    }
                },
                rationale: {
                    type: 'string',
                    description: 'Brief explanation of why this fix resolves the bug.'
                }
            },
            required: ['file', 'changes', 'rationale']
        }
    },
    {
        name: 'finish',
        description:
            'End the debug session and return a final summary. Call this when a fix has been proposed, when no progress can be made, or when the user goal is met.',
        input_schema: {
            type: 'object',
            properties: {
                summary: { type: 'string' }
            },
            required: ['summary']
        }
    }
];
