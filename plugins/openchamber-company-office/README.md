# OpenChamber Company Office

Declarative workspace contribution for OpenChamber Web, Desktop, hosted mobile, and
Capacitor mobile. It advertises the fixed, host-rendered `company-office` surface and its
authenticated snapshot endpoint.

This in-repository package boundary contains data only. It does not execute JavaScript, render React, register
server routes, read files, access Jira, or open OpenCode sessions. The matching
OpenChamber host version owns all of those operations.

It is not independently published or dynamically installed. Its `package.json` records
the intended distributable contract for a future loader. Installing or copying this
directory alone does not activate Company Office because the current
OpenChamber catalog is built in rather than dynamically discovered. To enable the
feature, deploy a compatible OpenChamber host and configure
`OPENCHAMBER_COMPANY_OFFICE_CONFIG` as described in `docs/COMPANY_OFFICE.md`.

Users may disable the contribution per client. Credentials and upstream source health
remain server-side.
