# `docs/migrations/` — agent-driven update instructions

[AGENT-AWARE-UPDATE-NOTIFICATIONS 2026-05-04]

## What this dir is for

This directory holds **per-update migration docs** that the auto-update probe
reads, extracts, and INJECTS into the `[BRIDGE-UPDATE-AVAILABLE]` bridge
message it drops into local harness inboxes every 3 hours.

Voice 2150 (2026-05-04) spec:

> "Every update should have instructions like changelog for the agent to
> perform because it might need to do it. The update is handled by the
> attached session — should tell the attached session by a similar mechanism
> how AgentBridge communicates normally that there is an update and then ask
> the agent itself to update and give it the instructions for how to. Not
> how the current system works now where it's all purely script-based. We
> can have some script-based stuff but..."

The previous flow only had `scripts/update.sh` (script-based pull + build +
reload). That works for mechanical updates but provides zero room for
agent-side judgment when an update needs more than mechanical steps —
e.g. when a config schema changes, when a one-shot data migration needs
running, when a different launchd service needs restarting, when a
deprecated env var needs removing.

This directory closes that gap: every meaningful update can ship with a
short markdown doc telling the receiving harness's agent EXACTLY what to do
beyond `git pull && npm run build`. The agent reads the injected text and
executes the listed actions — same way it would handle any other natural-
language directive that landed in its inbox.

## File naming convention

```
docs/migrations/<sha-or-version>.md
```

- `<sha-or-version>` is either the git SHA (short, 7-12 chars) of the head
  commit that introduces the migration, OR a semver version string when
  the migration is tied to a version bump (e.g. `4.0.0`,
  `3.14.5-plugin-registry-rewire`).
- One file per migration. Don't pile multiple migrations into a single
  file — the probe injects ONLY the latest applicable file into the
  bridge message body (see "Selection rule" below).
- Files in this dir are picked up via `git log --name-only` and existence
  checks; they MUST be tracked in git for the probe to find them.

## Required markdown structure

```markdown
# <Title — short, one-line summary of the migration>

## Context

<2-5 sentences explaining what changed and why. Optional but
recommended — gives the agent enough background to make sensible
judgment calls if the steps don't quite fit the current state.>

## Instructions for the agent receiving this update

<Numbered or bulleted steps the receiving agent should perform AFTER
the standard `git pull && npm run build` runs. Be specific — exact
commands, env vars to set/unset, services to restart, configs to
verify. Anything beyond mechanical pull+build belongs here.>

## Verification

<How the agent confirms the migration applied cleanly. Commands to
run, log lines to grep for, version strings to check.>

## Rollback (optional)

<If the migration is reversible, describe how. Skip this section if
not applicable.>
```

The auto-update probe specifically extracts the
`## Instructions for the agent receiving this update` section verbatim
and includes it in the `[BRIDGE-UPDATE-AVAILABLE]` message body. The
other sections are still useful as documentation in the file itself,
but only the "Instructions" section is injected.

## Selection rule

The probe (`scripts/check-update.sh`) does a `git log --name-only --diff-filter=A
LOCAL_HEAD..ORIGIN_HEAD -- docs/migrations/` to enumerate migration files
ADDED between the local checkout's HEAD and origin/main. For each new
file (newest commit first by `git log` order), the probe extracts the
"Instructions for the agent receiving this update" section and injects it
into the `[BRIDGE-UPDATE-AVAILABLE]` body.

If there are NO new migration files in the diff range, the bridge message
falls back to the standard "run scripts/update.sh + reload-plugins"
guidance. Most updates won't need a migration doc — only ones with steps
beyond mechanical pull+build.

## Relationship to CHANGELOG.md

`CHANGELOG.md` is for humans (release notes, what's new from a user's
POV). `docs/migrations/*.md` is for agents (specific actionable steps an
agent should run on receipt of the update). There's overlap, but the
audiences and the level of mechanical specificity differ. Don't replace
CHANGELOG entries with migration docs; they coexist.

## Examples

- `4.0.0-channel-plugin-rewrite.md` — example migration doc for the
  v4.0.0 channel plugin rewrite (e66a9bc area).
