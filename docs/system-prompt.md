# Owner-selected system prompts

Implemented for issue #96 (v6, S1). Off by default. This plugin contributes an ordered system section, not a repeating user-context snapshot. It never grants agent permissions.

## Configuration

```yaml
systemPrompt:
  enabled: false
  lessonDepth: 0
  maxChars: 4000
  order: 9000
```

`lessonDepth` is0–20 per approved lesson type;0 disables the lesson contribution. `maxChars` is500–20000 and includes plugin labels/header; `order` is200–10199. The four fields are one declared volatile configuration object exposed in the host settings form: changes take effect on the next model assembly without a plugin restart, including enable-from-off and section order. Plain startup `--patch` file edits are not a live settings write. Existing templates migrate to schema12 with `system_prompt = 0`. No template becomes active just because the plugin is upgraded.

## Owner switches and risk gate

Each non-lesson template has a separate system opt-in switch, independent from scheduled injection. Session templates apply only to their own session; globals apply to all sessions on hosts/profiles sharing the database. The master switch gates both. Enabling both channels may repeat the same text at a scheduled boundary.

Global switches require an in-page acknowledgement for either direction. Editing or deleting an active global template also requires acknowledgement. API updates must carry `confirm_global: true`; otherwise HTTP409 `confirm-global`. Confirmation is scoped to a request, not persisted permission. Promotion to global always resets the system switch off; new/imported rows are off. Bulk CLI imports cannot overwrite an active global row: first disable it through the confirmed owner route. A CLI snapshot remains schema4 portable business data; local system-prompt consent is intentionally not exported or restored.

Global amber and session blue distinguish category groups, including search headings, not rows. The native brand token is monochrome in the tested DSH theme, so session tabs use existing `--dsw-static-blue-450`, distinct from amber and focus/business. The title badge filters active globals. Risk text states only host-observable running/live counts; other profiles are not counted.

## Lessons and budget

Only tagged lesson text versions enter; old untagged data and unapproved custom types are excluded. For each type: take up toN newest right versions, then at most `min(right-1, N-right)` wrong versions. A class without a right version is absent; right must strictly outnumber wrong. Duplicate text digests count once. Current text is not guaranteed to enter.

Templates precede the lesson groups. Over budget, remove oldest wrong lessons first, then oldest right lessons; no lesson is cut and no majority is broken. Then shorten longest template bodies with a truncation notice, dropping an entry if even its labels cannot fit. A bounded100-session cache stores raw material; SQLite data-version/total-changes invalidate writes from this or another connection. Template clock variables expand per assembly, not per cache fill. Unknown double-brace text remains literal and is not rescanned by the host.

When registered system lessons are enabled with depth>0, startup/resume/compaction full-list handover stops; scheduled cards, digest prompts, event reminders, selfcheck and evolution remain unchanged. If the host lacks section/variable support, normal lesson delivery stays available and the plugin logs the limitation.

## Validation limits

Unit, mutation, actual host/model-request assembly, independent review and production installation are separate evidence layers. Synthetic model probes make no external LLM call and cannot measure paid-provider prompt-cache hits. Production remains untouched; enabling or publishing is not implied by merge.
