import type { NormalizedMessage } from './llm/types';

/**
 * Conversation-history compaction.
 *
 * Old tool results dominate a long run's prompt (every step result, every
 * variable dump) but stop being useful once the model has acted on them.
 * When the estimated prompt size crosses a threshold, stub out tool results
 * older than the most recent N, keeping error results and the outcomes of
 * propose_code_fix / finish intact.
 *
 * Pruning rewrites history, which invalidates the provider's message-suffix
 * prompt cache once — so the caller should only invoke it above a generous
 * threshold, and it prunes in one batch (the new prefix re-caches on the next
 * request).
 */

export interface CompactOptions {
    /** How many of the most recent tool results to keep verbatim. */
    keepRecentToolResults: number;
}

export interface CompactResult {
    messages: NormalizedMessage[];
    /** Number of tool results replaced by stubs. */
    pruned: number;
    /** Estimated characters saved. */
    savedChars: number;
}

/** Tools whose results must never be pruned — they record user decisions / outcomes. */
const PRESERVE_TOOLS = new Set(['propose_code_fix', 'finish']);

const PRUNED_MARKER = '"pruned":true';

export function estimateChars(messages: NormalizedMessage[]): number {
    let total = 0;
    for (const m of messages) {
        if (m.role === 'user') {
            total += m.content.length;
        } else if (m.role === 'assistant') {
            total += m.text?.length ?? 0;
            for (const tc of m.toolCalls) {
                total += tc.name.length + JSON.stringify(tc.input ?? {}).length;
            }
        } else {
            total += m.content.length;
        }
    }
    return total;
}

export function compactHistory(
    messages: NormalizedMessage[],
    opts: CompactOptions
): CompactResult {
    // Map toolCallId -> tool name so we know which results to preserve.
    const nameById = new Map<string, string>();
    for (const m of messages) {
        if (m.role === 'assistant') {
            for (const tc of m.toolCalls) {
                nameById.set(tc.id, tc.name);
            }
        }
    }

    // Indices of prunable tool results, oldest first.
    const prunable: number[] = [];
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.role !== 'tool') { continue; }
        if (m.isError) { continue; }
        if (m.content.includes(PRUNED_MARKER)) { continue; }
        const name = nameById.get(m.toolCallId);
        if (name && PRESERVE_TOOLS.has(name)) { continue; }
        prunable.push(i);
    }

    const toPrune = prunable.slice(0, Math.max(0, prunable.length - opts.keepRecentToolResults));
    if (toPrune.length === 0) {
        return { messages, pruned: 0, savedChars: 0 };
    }

    const pruneSet = new Set(toPrune);
    let savedChars = 0;
    const out = messages.map((m, i) => {
        if (!pruneSet.has(i) || m.role !== 'tool') {
            return m;
        }
        const name = nameById.get(m.toolCallId) ?? 'tool';
        const stub = JSON.stringify({
            pruned: true,
            tool: name,
            note: 'Old result elided to save context. Re-run the tool if you need this data again.'
        });
        savedChars += Math.max(0, m.content.length - stub.length);
        return { ...m, content: stub };
    });

    return { messages: out, pruned: toPrune.length, savedChars };
}
