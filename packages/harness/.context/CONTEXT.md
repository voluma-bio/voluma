# Harness

Two run loops share one shell. `run-loop.ts` is the task loop (tasks, checks, fix rounds); `agents/loop.ts` is the agent model's (main, named workers, messages, versions). A run is pinned to one at its first claim (`root thread.started.harness`).

- **Shared:** `loop-shell.ts` (wake-ups, starting a thread, stopping all, the root's end), `threads.ts`, the Pi adapter, `recorder.ts`, `sandbox-session.ts`, `failure-policy.ts` (what a failed main means), and `contracts/thread-records.ts` (the thread fields both logs read). `supervise-run.ts` picks `tasks-wire.ts` or `agents/wire.ts`.
- **Agent loop state** is `contracts/agents.ts` (`agentLog`): agents, their state (`agentState`, with the caller's `running`), inbox, notices, cursor. Nothing else is held in memory but `handed` (items given to a running thread whose user message is not stored yet; dropped when its invocation settles).
- **Tools** of the agent loop are `agents/tools/` (`registry.ts` is its own list; `report_output` there is not the task loop's). Every id a tool or the loop writes is derived (`agents/effects.ts`), so a repeat or a resume is a no-op.
- `agents/prompts.ts` and `workflows/core/roles/*.md` are placeholders until the roles lane replaces them.
