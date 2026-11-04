# Roles of the agent loop

`main.md` and `worker.md` are the role files; `words.md` and `environment.md`
are text `packages/harness/src/agents/prompts.ts` appends to every role's system prompt, and `review.md` is appended
to the review main's only (after the `researcher` skill); none of the three is a role.

Everything here is generic: no anatomy, no input type, no file of any workflow. The test: the same
`main.md` must read correctly for a protein-structure run. The method, the standards and the suggested plan
come from the workflow's skill, loaded into the first message. Main's brief is a worker's instructions, so `worker.md` holds only what every worker needs and
nothing enforces; a rule a tool governs goes in that tool's description, and talking with the researcher is
the `researcher` skill (a run main gets it with the researcher's first message; the review main has it and `review.md` in its system prompt). The one exception is `environment.md`'s
Python packages: they are the sandbox image's (`workflows/core/requirements.txt`), not a workflow's.

Frontmatter is `name`, `description`, `model`, `thinking`, `tools`; tool names come from the agent loop's
registry (`packages/harness/src/agents/tools/registry.ts`). Design: the docs repo's `work/agent-model/design/`
(`main-prompt.md`, `agents.md`).
