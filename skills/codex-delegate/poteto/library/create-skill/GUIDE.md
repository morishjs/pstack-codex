# Create a Codex skill

Use the host's skill-creator instructions when available. Otherwise:

1. Define the actual invocation, task boundary, and observable success criteria. Read the relevant source before editing.
2. Create one folder with `SKILL.md`, YAML `name` and `description`, and only the references or scripts the workflow uses. Use a lowercase hyphenated name under 64 characters. Keep the description selective and put branch-specific detail behind file links.
3. Use `.agents/skills/<name>` for a project skill or the host's documented user skill directory. Preserve an existing location. Do not emit Cursor-specific `mode`, `reminder`, or `.mdc` rules.
4. Preserve normal discovery unless the user requests explicit-only invocation; then use `policy.allow_implicit_invocation: false` in `agents/openai.yaml`.
5. Preserve user scope and the host's actual tool/authorization boundaries. Define unavailable-capability behavior, and never use an instruction as a substitute for implemented functionality.
6. Validate YAML, names, reference resolution and executable helpers. Use the bundled host validator if available. For complex behavior, test a realistic request with an independent agent when permitted. Structural validation alone is not behavioral proof.
7. Deliver the skill with its validation and invocation instructions. Commit, push, and publish only within the requested delivery scope.
