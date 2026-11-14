/**
 * Event-triggered reminders, detection half (pure): two first-phase rules
 * over one session's recent observations. Detectors never decide that work
 * was inefficient — they only surface a candidate problem with its evidence;
 * a reasonable repetition can be rejected by whoever handles the episode.
 *
 * @module dsh-prompt-templates/event-detect
 */

import { fingerprint } from './event-features.ts'

/** Rule identifiers shipped in this version. */
export const RULE_REPEATED_PREPARATION = 'repeated-preparation'
export const RULE_REPEATED_FAILURE = 'repeated-failure'
export type EventRuleId = typeof RULE_REPEATED_PREPARATION | typeof RULE_REPEATED_FAILURE
export const EVENT_RULES: readonly EventRuleId[] = [RULE_REPEATED_PREPARATION, RULE_REPEATED_FAILURE]

/** How many evidence call ids an episode keeps. */
export const EVIDENCE_REFS_MAX = 10

/** One stored observation as the detectors read it (oldest → newest order). */
export interface ObservationView {
  readonly seq: number
  readonly call_id: string
  readonly tool_name: string
  readonly is_ptc_subcall: boolean
  readonly stable_fingerprint: string
  readonly target_fingerprint: string
  readonly outcome: string
  readonly exit_code: number | null
  readonly summary: string
}

/** The tunable part of a rule's policy the detectors read. */
export interface DetectorPolicy {
  readonly rule_id: EventRuleId
  readonly rule_version: number
  readonly threshold: number
  readonly window_size: number
}

/** A problem candidate produced by one detector for the latest observation. */
export interface DetectionCandidate {
  readonly rule_id: EventRuleId
  readonly rule_version: number
  /** Stable problem key within a session; the episode identity derives from it. */
  readonly key: string
  readonly tool_name: string
  readonly target_fingerprint: string
  /** Evidence call ids, oldest first, bounded by EVIDENCE_REFS_MAX. */
  readonly evidence_refs: readonly string[]
  /** How many observations support the candidate (drives the evidence revision). */
  readonly evidence_count: number
  /** Redacted summary of the latest supporting observation. */
  readonly summary: string
  /** Outcome class of the latest supporting observation. */
  readonly outcome: string
}

function lastRefs(rows: readonly ObservationView[]): string[] {
  return rows.slice(-EVIDENCE_REFS_MAX).map(row => row.call_id)
}

/**
 * Repeated preparation: the same shared preparation prefix appears at least
 * `threshold` times inside the window while the task parts differ (an exact
 * re-run of one command is a retry, not repeated preparation).
 */
export function detectRepeatedPreparation(window: readonly ObservationView[], latest: ObservationView, policy: DetectorPolicy): DetectionCandidate | null {
  if (latest.stable_fingerprint === '') return null
  const matches = window.filter(row => row.stable_fingerprint === latest.stable_fingerprint)
  if (matches.length < policy.threshold) return null
  if (new Set(matches.map(row => row.target_fingerprint)).size < 2) return null
  return {
    rule_id: RULE_REPEATED_PREPARATION,
    rule_version: policy.rule_version,
    key: `prep:${latest.stable_fingerprint}`,
    tool_name: latest.tool_name,
    target_fingerprint: latest.target_fingerprint,
    evidence_refs: lastRefs(matches),
    evidence_count: matches.length,
    summary: latest.summary,
    outcome: latest.outcome,
  }
}

/**
 * Repeated failure: the same target fails with the same structured outcome
 * at least `threshold` times inside the window, or fails again after it had
 * succeeded (a regression). Outcome classes come from structured fields only.
 */
export function detectRepeatedFailure(window: readonly ObservationView[], latest: ObservationView, policy: DetectorPolicy): DetectionCandidate | null {
  if (!latest.outcome.startsWith('error')) return null
  const sameTarget = window.filter(row => row.tool_name === latest.tool_name && row.target_fingerprint === latest.target_fingerprint)
  const sameFailure = sameTarget.filter(row => row.outcome === latest.outcome)
  let recurred = false
  let sawError = false
  let sawOkAfterError = false
  for (const row of sameTarget) {
    if (row.seq === latest.seq) break
    if (row.outcome.startsWith('error')) sawError = true
    else if (sawError) sawOkAfterError = true
  }
  if (sawError && sawOkAfterError) recurred = true
  if (sameFailure.length < policy.threshold && !recurred) return null
  const failures = sameTarget.filter(row => row.outcome.startsWith('error'))
  return {
    rule_id: RULE_REPEATED_FAILURE,
    rule_version: policy.rule_version,
    key: `fail:${fingerprint(`${latest.tool_name}\u0000${latest.target_fingerprint}\u0000${latest.outcome}`)}`,
    tool_name: latest.tool_name,
    target_fingerprint: latest.target_fingerprint,
    evidence_refs: lastRefs(failures),
    evidence_count: failures.length,
    summary: latest.summary,
    outcome: latest.outcome,
  }
}

/** Run one rule's detector. */
export function detect(window: readonly ObservationView[], latest: ObservationView, policy: DetectorPolicy): DetectionCandidate | null {
  return policy.rule_id === RULE_REPEATED_PREPARATION
    ? detectRepeatedPreparation(window, latest, policy)
    : detectRepeatedFailure(window, latest, policy)
}

/** The part of an episode needed to interpret a later observation. */
export interface EpisodeProbe {
  readonly rule_id: EventRuleId
  readonly key: string
  readonly tool_name: string
  readonly target_fingerprint: string
}

/**
 * Whether a later observation looks like the behaviour changed after a
 * reminder: for repeated preparation, the same tool ran WITHOUT that
 * preparation prefix; for repeated failure, the same target now succeeds.
 * This is only a signal for whoever closes the episode — never a verdict.
 */
export function looksChanged(episode: EpisodeProbe, row: ObservationView): boolean {
  if (episode.rule_id === RULE_REPEATED_PREPARATION) {
    return row.tool_name === episode.tool_name && `prep:${row.stable_fingerprint}` !== episode.key
  }
  return row.tool_name === episode.tool_name && row.target_fingerprint === episode.target_fingerprint && row.outcome === 'ok'
}
