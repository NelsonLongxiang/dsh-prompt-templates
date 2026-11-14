/**
 * Event-triggered reminders, persistence half: rule policies, redacted
 * observations, problem episodes and the reminder outbox, stored in the
 * plugin's own SQLite file (schema v5, created by TemplateStore's migration).
 *
 * Two state machines are kept apart on purpose:
 *   - episode (problem handling): observed → notified → (human-set) applied /
 *     verified / ineffective / reverted / rejected / deferred /
 *     awaiting_authorization. The plugin itself never goes past `notified`.
 *   - outbox (message delivery): prepared → persisted, or retry_pending →
 *     prepared again, failed after too many attempts, superseded when newer
 *     evidence replaces an undelivered reminder.
 *
 * @module dsh-prompt-templates/event-store
 */

import type { DatabaseSync } from 'node:sqlite'
import { EVENT_RULES, EVIDENCE_REFS_MAX, RULE_REPEATED_FAILURE, RULE_REPEATED_PREPARATION, looksChanged } from './event-detect.ts'
import type { DetectionCandidate, EventRuleId, ObservationView } from './event-detect.ts'
import { fingerprint } from './event-features.ts'
import type { ObservationFeatures } from './event-features.ts'
import type { TemplateInjectMode } from './types.ts'

/** DDL for the v5 event tables; runs inside the store's migration transaction. */
export const EVENT_SCHEMA_SQL = `CREATE TABLE event_policies (
  rule_id TEXT PRIMARY KEY,
  rule_version INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  threshold INTEGER NOT NULL,
  window_size INTEGER NOT NULL,
  cooldown_turns INTEGER NOT NULL,
  max_per_episode INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'visible',
  updated_at TEXT NOT NULL
);
CREATE TABLE event_observations (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  is_ptc_subcall INTEGER NOT NULL DEFAULT 0,
  stable_fingerprint TEXT NOT NULL,
  target_fingerprint TEXT NOT NULL,
  outcome TEXT NOT NULL,
  exit_code INTEGER,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE event_episodes (
  episode_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  key TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  target_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL,
  evidence_refs TEXT NOT NULL,
  evidence_revision INTEGER NOT NULL,
  notified_revision INTEGER NOT NULL DEFAULT 0,
  notify_count INTEGER NOT NULL DEFAULT 0,
  signal TEXT,
  summary TEXT NOT NULL,
  outcome TEXT NOT NULL,
  cooldown_until_turn INTEGER NOT NULL DEFAULT 0,
  resolution_refs TEXT,
  resolution_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX event_episodes_session ON event_episodes (session_id, state);
CREATE TABLE event_outbox (
  dedup_key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  evidence_revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  turn INTEGER NOT NULL,
  step INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX event_outbox_session ON event_outbox (session_id, state)`

/** Shipped default policies: every rule starts DISABLED. */
export const DEFAULT_POLICIES: readonly Omit<EventPolicyView, 'updated_at'>[] = [
  { rule_id: RULE_REPEATED_PREPARATION, rule_version: 1, enabled: false, threshold: 3, window_size: 50, cooldown_turns: 3, max_per_episode: 2, mode: 'visible' },
  { rule_id: RULE_REPEATED_FAILURE, rule_version: 1, enabled: false, threshold: 2, window_size: 50, cooldown_turns: 3, max_per_episode: 2, mode: 'visible' },
]

/** Seed the default policy rows (idempotent). */
export function seedDefaultPolicies(db: DatabaseSync): void {
  const insert = db.prepare(`INSERT OR IGNORE INTO event_policies
    (rule_id, rule_version, enabled, threshold, window_size, cooldown_turns, max_per_episode, mode, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const policy of DEFAULT_POLICIES) {
    insert.run(policy.rule_id, policy.rule_version, policy.enabled ? 1 : 0, policy.threshold, policy.window_size,
      policy.cooldown_turns, policy.max_per_episode, policy.mode, now())
  }
}

/** One rule's policy as served to routes and read by the observer/consumer. */
export interface EventPolicyView {
  readonly rule_id: EventRuleId
  readonly rule_version: number
  readonly enabled: boolean
  readonly threshold: number
  readonly window_size: number
  readonly cooldown_turns: number
  readonly max_per_episode: number
  readonly mode: TemplateInjectMode
  readonly updated_at: string
}

/** Editable policy fields; the rule id and version are not editable here. */
export interface EventPolicyUpdate {
  readonly enabled?: boolean
  readonly threshold?: number
  readonly window_size?: number
  readonly cooldown_turns?: number
  readonly max_per_episode?: number
  readonly mode?: TemplateInjectMode
}

/** Problem-handling states. Only `observed` and `notified` are set by the plugin. */
export const EPISODE_STATES = [
  'observed', 'notified', 'awaiting_authorization', 'rejected', 'deferred',
  'applied', 'verified', 'ineffective', 'reverted',
] as const
export type EpisodeState = (typeof EPISODE_STATES)[number]

/** States a human or agent may set through the audit route, with evidence. */
export const RESOLVABLE_STATES: readonly EpisodeState[] = EPISODE_STATES.filter(state => state !== 'observed' && state !== 'notified')

/** States in which new evidence may trigger another reminder. */
const NOTIFIABLE_STATES: readonly EpisodeState[] = ['observed', 'notified', 'ineffective', 'reverted']

/** One problem episode as served to the audit route. */
export interface EpisodeView {
  readonly episode_id: string
  readonly session_id: string
  readonly rule_id: EventRuleId
  readonly rule_version: number
  readonly key: string
  readonly tool_name: string
  readonly target_fingerprint: string
  readonly state: EpisodeState
  readonly evidence_refs: readonly string[]
  readonly evidence_revision: number
  readonly notified_revision: number
  readonly notify_count: number
  /** `changed` / `repeated` after a reminder; a hint, never a verdict. */
  readonly signal: 'changed' | 'repeated' | null
  readonly summary: string
  readonly outcome: string
  readonly cooldown_until_turn: number
  readonly resolution_refs: readonly string[]
  readonly resolution_note: string | null
  readonly created_at: string
  readonly updated_at: string
}

/** Delivery states of one queued reminder. */
export type OutboxState = 'prepared' | 'persisted' | 'retry_pending' | 'failed' | 'superseded'

/** One outbox row. */
export interface OutboxView {
  readonly dedup_key: string
  readonly session_id: string
  readonly episode_id: string
  readonly evidence_revision: number
  readonly state: OutboxState
  readonly attempts: number
  readonly turn: number
  readonly step: number
  readonly created_at: string
  readonly updated_at: string
}

/** Validation failure surfaced to routes as HTTP 400. */
export class EventRuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EventRuleError'
  }
}

function now(): string {
  return new Date().toISOString()
}

interface EpisodeRow extends Omit<EpisodeView, 'evidence_refs' | 'resolution_refs'> {
  evidence_refs: string
  resolution_refs: string | null
}

function episodeView(row: EpisodeRow): EpisodeView {
  return {
    ...row,
    evidence_refs: JSON.parse(row.evidence_refs) as string[],
    resolution_refs: row.resolution_refs === null ? [] : JSON.parse(row.resolution_refs) as string[],
  }
}

interface PolicyRow extends Omit<EventPolicyView, 'enabled'> { enabled: number }

function policyView(row: PolicyRow): EventPolicyView {
  return { ...row, enabled: row.enabled === 1 }
}

interface ObservationRow extends Omit<ObservationView, 'is_ptc_subcall'> { is_ptc_subcall: number }

function observationView(row: ObservationRow): ObservationView {
  return { ...row, is_ptc_subcall: row.is_ptc_subcall === 1 }
}

/** Deterministic episode identity within one session. */
export function episodeIdFor(sessionId: string, ruleId: EventRuleId, key: string): string {
  return `ep_${fingerprint(`${sessionId}\u0000${ruleId}\u0000${key}`)}`
}

/** Idempotence key of one reminder delivery. */
export function dedupKeyFor(sessionId: string, episode: Pick<EpisodeView, 'episode_id' | 'rule_id' | 'rule_version'>, revision: number): string {
  return `${sessionId}|${episode.episode_id}|${revision}|${episode.rule_id}@${episode.rule_version}|notify`
}

function positiveInt(name: string, value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new EventRuleError(`${name} must be an integer between 1 and ${max}`)
  }
  return value
}

/** Event-reminder persistence over the plugin's SQLite handle. */
export class EventStore {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  /** Every rule policy, in rule order. */
  policies(): EventPolicyView[] {
    const rows = this.db.prepare('SELECT * FROM event_policies').all() as unknown as PolicyRow[]
    return EVENT_RULES.flatMap(rule => rows.filter(row => row.rule_id === rule)).map(policyView)
  }

  /** One rule policy; `undefined` for an unknown rule. */
  policy(ruleId: string): EventPolicyView | undefined {
    const row = this.db.prepare('SELECT * FROM event_policies WHERE rule_id = ?').get(ruleId) as PolicyRow | undefined
    return row === undefined ? undefined : policyView(row)
  }

  /** Update one rule policy; `undefined` for an unknown rule. */
  updatePolicy(ruleId: string, patch: EventPolicyUpdate): EventPolicyView | undefined {
    const current = this.policy(ruleId)
    if (current === undefined) return undefined
    const enabled = patch.enabled ?? current.enabled
    if (typeof enabled !== 'boolean') throw new EventRuleError('enabled must be a boolean')
    const threshold = patch.threshold === undefined ? current.threshold : positiveInt('threshold', patch.threshold, 100)
    const windowSize = patch.window_size === undefined ? current.window_size : positiveInt('window_size', patch.window_size, 1000)
    const cooldown = patch.cooldown_turns === undefined ? current.cooldown_turns : positiveInt('cooldown_turns', patch.cooldown_turns, 1000)
    const maxPerEpisode = patch.max_per_episode === undefined ? current.max_per_episode : positiveInt('max_per_episode', patch.max_per_episode, 100)
    const mode = patch.mode ?? current.mode
    if (mode !== 'inject' && mode !== 'visible') throw new EventRuleError(`mode must be 'inject' or 'visible' (got ${String(mode)})`)
    this.db.prepare(`UPDATE event_policies SET enabled = ?, threshold = ?, window_size = ?, cooldown_turns = ?,
      max_per_episode = ?, mode = ?, updated_at = ? WHERE rule_id = ?`)
      .run(enabled ? 1 : 0, threshold, windowSize, cooldown, maxPerEpisode, mode, now(), ruleId)
    return this.policy(ruleId)
  }

  /** Append one observation and trim the session to its newest `retain` rows. */
  recordObservation(sessionId: string, callId: string, isPtcSubcall: boolean, features: ObservationFeatures, retain: number): ObservationView {
    const last = this.db.prepare('SELECT MAX(seq) AS seq FROM event_observations WHERE session_id = ?').get(sessionId) as { seq: number | null }
    const seq = (last.seq ?? 0) + 1
    this.db.prepare(`INSERT INTO event_observations
      (session_id, seq, call_id, tool_name, is_ptc_subcall, stable_fingerprint, target_fingerprint, outcome, exit_code, summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, seq, callId, features.toolName, isPtcSubcall ? 1 : 0, features.stableFingerprint,
        features.targetFingerprint, features.outcome, features.exitCode, features.summary, now())
    this.db.prepare('DELETE FROM event_observations WHERE session_id = ? AND seq <= ?').run(sessionId, seq - retain)
    return this.window(sessionId, 1)[0] as ObservationView
  }

  /** The newest `size` observations of a session, oldest first. */
  window(sessionId: string, size: number): ObservationView[] {
    const rows = this.db.prepare('SELECT * FROM event_observations WHERE session_id = ? ORDER BY seq DESC LIMIT ?')
      .all(sessionId, size) as unknown as ObservationRow[]
    return rows.reverse().map(observationView)
  }

  /**
   * Fold one detection into its episode: create it, or add evidence. Every
   * new supporting observation raises the evidence revision by one; evidence
   * arriving after a reminder flags the episode `repeated`.
   */
  upsertEpisode(sessionId: string, candidate: DetectionCandidate): EpisodeView {
    const id = episodeIdFor(sessionId, candidate.rule_id, candidate.key)
    const existing = this.episode(id)
    const refs = JSON.stringify(candidate.evidence_refs.slice(-EVIDENCE_REFS_MAX))
    const at = now()
    if (existing === undefined) {
      this.db.prepare(`INSERT INTO event_episodes
        (episode_id, session_id, rule_id, rule_version, key, tool_name, target_fingerprint, state, evidence_refs,
         evidence_revision, summary, outcome, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'observed', ?, 1, ?, ?, ?, ?)`)
        .run(id, sessionId, candidate.rule_id, candidate.rule_version, candidate.key, candidate.tool_name,
          candidate.target_fingerprint, refs, candidate.summary, candidate.outcome, at, at)
    } else {
      const signal = existing.notify_count > 0 ? 'repeated' : existing.signal
      this.db.prepare(`UPDATE event_episodes SET evidence_refs = ?, evidence_revision = evidence_revision + 1,
        rule_version = ?, signal = ?, summary = ?, outcome = ?, updated_at = ? WHERE episode_id = ?`)
        .run(refs, candidate.rule_version, signal, candidate.summary, candidate.outcome, at, id)
    }
    return this.episode(id) as EpisodeView
  }

  /** Flag notified episodes whose later observation looks like changed behaviour. */
  noteChanges(sessionId: string, row: ObservationView, supporting: ReadonlySet<string>): void {
    const notified = this.db.prepare("SELECT * FROM event_episodes WHERE session_id = ? AND state = 'notified'")
      .all(sessionId) as unknown as EpisodeRow[]
    for (const episode of notified.map(episodeView)) {
      if (supporting.has(episode.episode_id)) continue
      if (looksChanged(episode, row)) {
        this.db.prepare("UPDATE event_episodes SET signal = 'changed', updated_at = ? WHERE episode_id = ?").run(now(), episode.episode_id)
      }
    }
  }

  /** One episode by id. */
  episode(id: string): EpisodeView | undefined {
    const row = this.db.prepare('SELECT * FROM event_episodes WHERE episode_id = ?').get(id) as EpisodeRow | undefined
    return row === undefined ? undefined : episodeView(row)
  }

  /** A session's episodes, newest first. */
  episodes(sessionId: string): EpisodeView[] {
    return (this.db.prepare('SELECT * FROM event_episodes WHERE session_id = ? ORDER BY updated_at DESC, episode_id')
      .all(sessionId) as unknown as EpisodeRow[]).map(episodeView)
  }

  /**
   * Episodes that may be reminded about at `turn`: notifiable state, enabled
   * policy, new evidence since the last reminder, cooldown over, per-episode
   * budget left, and no undelivered reminder already pending.
   */
  dueEpisodes(sessionId: string, turn: number): EpisodeView[] {
    const enabled = new Map(this.policies().filter(policy => policy.enabled).map(policy => [policy.rule_id, policy]))
    if (enabled.size === 0) return []
    const pending = new Set((this.db.prepare(
      "SELECT episode_id FROM event_outbox WHERE session_id = ? AND state IN ('prepared', 'retry_pending')",
    ).all(sessionId) as Array<{ episode_id: string }>).map(row => row.episode_id))
    const placeholders = NOTIFIABLE_STATES.map(() => '?').join(', ')
    const rows = this.db.prepare(`SELECT * FROM event_episodes WHERE session_id = ? AND state IN (${placeholders})
      AND evidence_revision > notified_revision AND cooldown_until_turn <= ? ORDER BY created_at, episode_id`)
      .all(sessionId, ...NOTIFIABLE_STATES, turn) as unknown as EpisodeRow[]
    return rows.map(episodeView).filter(episode => {
      const policy = enabled.get(episode.rule_id)
      return policy !== undefined && episode.notify_count < policy.max_per_episode && !pending.has(episode.episode_id)
    })
  }

  /** Record a reminder as handed to the step (delivery `prepared`, episode `notified`). */
  prepare(sessionId: string, episode: EpisodeView, turn: number, step: number, fresh: boolean, dedupKey: string, cooldownTurns: number): void {
    const at = now()
    this.db.exec('BEGIN')
    try {
      this.db.prepare(`INSERT INTO event_outbox
        (dedup_key, session_id, episode_id, evidence_revision, state, attempts, turn, step, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'prepared', 1, ?, ?, ?, ?)
        ON CONFLICT(dedup_key) DO UPDATE SET state = 'prepared', attempts = attempts + 1, turn = excluded.turn,
          step = excluded.step, updated_at = excluded.updated_at`)
        .run(dedupKey, sessionId, episode.episode_id, episode.evidence_revision, turn, step, at, at)
      if (fresh) {
        this.db.prepare(`UPDATE event_episodes SET state = 'notified', notified_revision = ?, notify_count = notify_count + 1,
          signal = NULL, cooldown_until_turn = ?, updated_at = ? WHERE episode_id = ?`)
          .run(episode.evidence_revision, turn + cooldownTurns, at, episode.episode_id)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Outbox rows of a session in the given states, oldest first. */
  outbox(sessionId: string, states?: readonly OutboxState[]): OutboxView[] {
    if (states === undefined) {
      return this.db.prepare('SELECT * FROM event_outbox WHERE session_id = ? ORDER BY created_at, dedup_key')
        .all(sessionId) as unknown as OutboxView[]
    }
    const placeholders = states.map(() => '?').join(', ')
    return this.db.prepare(`SELECT * FROM event_outbox WHERE session_id = ? AND state IN (${placeholders}) ORDER BY created_at, dedup_key`)
      .all(sessionId, ...states) as unknown as OutboxView[]
  }

  /** Whether a session has any reminder awaiting reconciliation. */
  hasPrepared(sessionId: string): boolean {
    return this.db.prepare("SELECT 1 FROM event_outbox WHERE session_id = ? AND state = 'prepared' LIMIT 1").get(sessionId) !== undefined
  }

  /** Move one outbox row to a new delivery state. */
  setOutboxState(dedupKey: string, state: OutboxState): void {
    this.db.prepare('UPDATE event_outbox SET state = ?, updated_at = ? WHERE dedup_key = ?').run(state, now(), dedupKey)
  }

  /** How many reminders a session already received (or has in flight) at `turn`. */
  deliveredAtTurn(sessionId: string, turn: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM event_outbox WHERE session_id = ? AND turn = ? AND state IN ('prepared', 'persisted')")
      .get(sessionId, turn) as { n: number }
    return row.n
  }

  /**
   * Set a human/agent resolution on an episode. Evidence references are
   * mandatory: a self-report is not evidence of changed behaviour.
   */
  resolveEpisode(id: string, state: unknown, refs: unknown, note: unknown): EpisodeView | undefined {
    const existing = this.episode(id)
    if (existing === undefined) return undefined
    if (typeof state !== 'string' || !(RESOLVABLE_STATES as readonly string[]).includes(state)) {
      throw new EventRuleError(`state must be one of ${RESOLVABLE_STATES.join(', ')}`)
    }
    if (!Array.isArray(refs) || refs.length === 0 || !refs.every(ref => typeof ref === 'string' && ref.trim() !== '' && ref.length <= 256)) {
      throw new EventRuleError('evidence_refs must be a non-empty array of call ids or session event references')
    }
    if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 512)) {
      throw new EventRuleError('note must be a string of at most 512 characters')
    }
    this.db.prepare('UPDATE event_episodes SET state = ?, resolution_refs = ?, resolution_note = ?, updated_at = ? WHERE episode_id = ?')
      .run(state, JSON.stringify(refs.slice(0, EVIDENCE_REFS_MAX)), (note as string | null | undefined) ?? null, now(), id)
    return this.episode(id)
  }
}
