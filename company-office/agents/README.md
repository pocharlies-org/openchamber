# Company Office agents

The role prompts the Company Office employees run with, versioned here next to the Jira
plugin they work through. These are a mirror of the operator's OpenCode configuration:

| File here | Source of truth |
| --- | --- |
| `AGENTS.md` | `~/.config/opencode/AGENTS.md` |
| `company/*.md` | `~/.config/opencode/agents/company/*.md` |
| `skirmshop.md` | `~/.config/opencode/agents/skirmshop.md` |

OpenCode reads the files under `~/.config/opencode`, not this directory. A change made
here is a proposal until it is copied there; a change made there is not shared until it is
copied back. Keep the two in step in the same commit whenever possible.

`AGENTS.md` carries the rules every role inherits — Brain memory, authorities, where work
happens, the competence boundary, **standard before custom**, and reporting. Each role file
carries only what is specific to that role, plus its OpenCode permission map in the front
matter. The permission map is the boundary, not a suggestion: `cto`, `pm` and `po` cannot
edit, `sre` is read-only against production, `devops` cannot mutate the cluster by hand.

## Standard before custom

Every role escalates the standard-vs-custom question to the `cto`, who owns it:

1. Something the stack already runs.
2. An established open-source project or a standard.
3. Only then, our own implementation.

The official documentation of the candidate is read before the decision — the project's own
docs, spec or source, not a blog post or a recollection of an API. The CTO audits what the
stack already has, rules, **and explains why**. Optimal beats fast: the goal is being right,
not being done.
