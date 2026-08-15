## Agent skills

### Issue tracker

Issues live in GitHub Issues for this repo (0xnicholas/totem), driven via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical labels, each string equal to its name: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `CONTEXT.md` at the repo root, ADRs in `docs/adr/`. See `docs/agents/domain.md`.

### Dev-time probing

lark-cli is a probing tool (own user, dev app, sandbox; `--dry-run` first for destructive probes; never a dependency). See `docs/agents/dev-probing.md`.
