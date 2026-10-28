
- Model aliases: an agent definition's `model:` alias is parsed but not used; every role runs on the runner's configured model. Add the server-side alias table and the per-workflow override (spec: workflow-md-format.md).
- Roles `main` and `review` are parsed but not started; `checker`'s tools and instructions apply to check threads only.
- The importer needs `GITHUB_TOKEN` for private repos and fetches one file per request; a package with hundreds of resource files wants the tarball instead.
