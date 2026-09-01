# Hazard: local 3081 "test host" was serving the production DSH_HOME

## What happened (2026-08-30)

The listener process on port 3081 (`dsh web --port 3081`, started without a
`DSH_HOME` environment variable) resolved the DEFAULT production home
(`C:\Users\Administrator\.dsh`). A test template POST aimed at
`http://127.0.0.1:3081` therefore landed in the PRODUCTION prompt-templates
SQLite database, and a production global template with inject N=1 briefly
injected into every production session until it was disabled and deleted.

## Constraint / rule

- The 3081 test isolation stated in the `dsh-plugin-dev-test` skill
  (`DSH_HOME=D:\dsh-test-homes\3081`) only holds if the host process is
  actually started with that env. Verify before writing:
  `Get-CimInstance Win32_Process` on the 3081 listener pid, or compare the
  template lists of :3080 and :3081 (identical lists = same home = hazard).
- Restarting 3081 must set `DSH_HOME=D:\dsh-test-homes\3081` explicitly;
  `/__dsh_restart` inherits the parent env, so a wrongly-started parent
  stays wrong across restarts.
- Before any POST/mutation against a "test" port, run one read-only probe
  and diff against production to confirm home identity.

## Detection recipe

```powershell
$t3080 = (Invoke-WebRequest http://127.0.0.1:3080/plugins/dsh-prompt-templates/templates).Content
$t3081 = (Invoke-WebRequest http://127.0.0.1:3081/plugins/dsh-prompt-templates/templates).Content
# identical content => same DB => 3081 is production-backed
```
