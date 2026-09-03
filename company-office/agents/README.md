# Company Office agent template

A starting set of role prompts for the employees a Company Office installation runs, kept
next to the Jira plugin they work through. It is a **template, not a configuration**: no
company, no people, no paths, no tracker identifiers — the same neutrality the rest of the
Company Office documentation follows.

OpenCode loads agents from `agent/` or `agents/` under its config directory. Copy these
files there, then add whatever your installation needs on top:

- The tool denials for your own MCP planes. They are deliberately absent here, because the
  set of planes is company-specific and naming them would be publishing your topology.
- Your memory or retrieval plane, if you have one.
- Any role your company has and this set does not.

`AGENTS.md` carries the rules every role inherits — memory, authorities, where work
happens, the competence boundary, **standard before custom**, and reporting. Each role file
carries only what is specific to that role, plus its permission map in the front matter.
The permission map is the boundary, not a suggestion: `cto`, `pm` and `po` cannot edit,
`sre` is read-only against production, `devops` cannot mutate the cluster by hand.

## Standard before custom

Every role escalates the standard-vs-custom question to the `cto`, who owns it:

1. Something the stack already runs.
2. An established open-source project or a standard.
3. Only then, an implementation of our own.

The official documentation of the candidate is read before the decision — the project's own
docs, spec or source, not a blog post or a recollection of an API. The CTO audits what the
stack already has by reading it, takes live signals from `sre` because `kubectl` is denied
to that role, rules, **and explains why**. Optimal beats fast: the goal is being right, not
being done.
