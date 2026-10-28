---
name: smoke
title: Runner smoke test
roles:
  worker: smoke-analyst
---

A tiny workflow to check the runner end to end, not an analysis. Be brief, and say which
command each number came from.

## Task: count-files

```yaml
depends: []
outputs:
  - {id: file-count, kind: measurement, unit: files, range: [1, 100000]}
```

Count the regular files under /inputs, following the scan-notes skill. Report the count.

### Done when

- file-count is reported as a whole number.

## Task: list-extensions

```yaml
depends: [count-files]
outputs:
  - {id: extensions, kind: file, mediaType: text/plain}
```

Write the distinct file extensions under /inputs, one per line, to /outputs/list-extensions/extensions.txt
and report it as the `extensions` output.

### Done when

- extensions.txt has one distinct extension per line.
