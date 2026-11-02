# Roles of the agent loop

`main.md` and `worker.md` are the role files of runs pinned `harness: agents`; `words.md` and `environment.md`
are text `packages/harness/src/agents/prompts.ts` appends to every role's system prompt, and are not roles.
`workflows/core/agents/` is the task loop's and goes with it; then `git mv roles agents`.

Everything here is generic: no anatomy, no input type, no file of any workflow. The test: the same
`main.md` must read correctly for a protein-structure run. The method, the standards and the suggested plan
come from the workflow's skill, loaded into the first message. The one exception is `environment.md`'s
Python packages: they are the sandbox image's (`workflows/core/requirements.txt`), not a workflow's.

Frontmatter is `name`, `description`, `model`, `thinking`, `tools`; tool names come from the agent loop's
registry (`packages/harness/src/agents/tools/registry.ts`). Design: the docs repo's `work/agent-model/design/`
(`main-prompt.md`, `agents.md`).
