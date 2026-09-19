# Codex Working Agreement

## Before changing code

- For a substantive task, state the intended approach and affected files before editing.
- Read this file and the relevant project documentation before searching broadly or modifying code.
- Check official, version-appropriate documentation before using an unfamiliar external API, library, service, or tool. Do not infer its behavior from memory.
- Treat claimed safety properties of third-party systems (especially identity, billing, and data-deletion flows) as unverified until confirmed in official documentation and, where appropriate, by a read-only lookup of live state.

## Implementation

- Prefer root-cause, durable fixes. Call out a larger required fix rather than silently shipping a stopgap.
- Keep credentials and personal data out of source, logs, commits, and replies. Use an ignored local environment file or the project's secret-management mechanism.
- Update relevant README or architecture documentation when behavior or architecture changes.
- Change the source/template for generated artifacts, then regenerate them; do not hand-edit generated output.
- Reuse existing framework/runtime capabilities when they fit; research current best practice before building non-trivial custom infrastructure.

## Verification and Git

- Run the relevant checks before declaring work complete, and report their actual outcome. Never alter tests simply to make them pass.
- Before running tests, identify whether the project has an offline or mocked test command; do not accidentally invoke paid or production-facing services.
- Do not call a failure pre-existing unless it is demonstrated on the relevant base revision.
- Before a commit or push, inspect the current branch, the exact diff, and staged files. Do not push directly to `main`, force-push a shared branch, or use broad staging commands such as `git add .` or `git add -A`.
- Scan staged changes for secrets and personal data before pushing.

## Codex workflow

- Use Codex skills when their documented trigger applies. Use subagents only when allowed by the active workspace instructions and when the task benefits from independent parallel work.
- Batch independent read-only checks, prefer targeted reads, and avoid re-reading already inspected material.
- For long-running operations, poll to completion and report real progress; do not abandon or restart expensive work merely for convenience.
- Record material, repeatable project-specific mistakes in the project guidance. Promote a lesson that recurs into a concise standing rule.

## Project-specific verification notes

- Keep Three.js context creation and rendering in the OffscreenCanvas worker: the main-thread prototype caused a multi-second input-blocking startup in the VPS mobile audit.
- Three.js instanced colours do not require `vertexColors: true`; enable vertex colours only when geometry has an actual colour attribute, otherwise the stone can render black.
- Astro background-server state can differ across sandbox boundaries. Inspect the exact project PID and listening port before restarting; use the printed port, and do not append a second `--port` to a script already specifying one.
