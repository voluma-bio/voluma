---
name: mouse-oa
description: Measure a mouse OA knee micro-CT scan following the Tang et al. (Biology 2026) protocol, task by task, with evidence for every value.
---

# Mouse OA

Stub. The protocol, the steering learned from expert runs, the task list,
the parameter catalog and the review template arrive in later PRs.

The analysis tools (segmentation, morphometry, landmarks) live in
`scripts/` as Python, managed with uv (`pyproject.toml`). They take and
return file paths, never bytes, and don't know which host runs them.
