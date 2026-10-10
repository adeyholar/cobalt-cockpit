// Cobalt Cockpit: a coding HUD and workflow controller.
//
// The HUD above the prompt and the /cockpit pane draw one task model
// (model.ts): milestones Claude declares through the `progress` tool, and
// verification gates settled by real command results or by Claude's report.
// A turn ending changes none of it. Everything a drawing reads lives in
// `$.state`, so a hot reload of this module loses nothing; what is kept here
// in variables (timers, the mounted waveform) is rebuilt as events arrive.
// No bookkeeping in this file may fail a tool call: it runs under `quiet`.

import { emptySwarm, configureSwarm, submitTask, admitTask, bindAgent, finishTask, resolveEscalation, setWave, escalateTask, verifyTask, reportResult, acknowledgeHandback, requestCancel, releaseReservation, summarizeSwarm, markStalled, heartbeat, normalizeOwned, overlaps, ownershipAllows, setAppliedEffort, setLaunchEffort, SONNET_LED_SWARM } from './swarm'
import type { Swarm, SwarmTask, ModelTier, Wave, Verification } from './swarm'
import { textOf } from './ledger'
import { atom, read, update } from 'claude-code'
import { desiredRequest, policyMismatch, AGENT_MODEL, HAIKU_MODEL, MAIN_MODEL, OPUS_MODEL, isProfile, DEFAULT_PROFILE } from './model-policy'
import type { SubagentTier, Profile } from './model-policy'
import { discoveryRows, guidanceFor, markGuided, needsAlignment, unpin, withDiscovery } from './discovery'
import { addConsult, advanceReview, briefOf, clearReview, consultVerdict, factsOf, hasReturned, isCandidate, isGround, promptOrigin, releaseDecision, revalidateRelease, withRelease, mandatoryGrounds, packetOf, promptGroundsOf, readScopeOf, requireReview, CONSULT_EFFORT, GROUNDS } from './consult'
import type { Consultation } from './consult'
import type { ReleaseOutcome, ReleaseRecord, AlertRecord } from '../types'
import { addDecision, adjudicate, adviceLine, answerOf, callsFor, carriesCredential, decisionOf, deterministicRoute, operatorNotice, readAnswers, routerArgv, routerLabel, routerLine, routerModeOf, routerStateOf, switchRouter, withDecision, AVAILABILITY_STATE, CALL_TIMEOUT_MS, EMPTY_ROUTER, PROVIDER, ROUTER_MODES } from './router'
import type { ActiveMode, RouterAnswer, RouterMode, RouterPolicy, RouterState } from './router'
import {
  DEFAULT_CEILING,
  capabilityFor,
  chooseEffort,
  effortPolicyText,
  factsFromRole,
  hostEffort,
  isEffortLevel,
  isEffortRequest,
  launchFallback,
  observeCapability,
  settingsEffort,
} from './effort'
import type { EffortFacts, EffortResolution, HostEffortSignals } from './effort'
import { orchestrationGraph, orchestrationTape } from './field'
import type { EngineInterface, On, Register, RenderElement, Timer } from 'claude-code'
import { addAgent, adoptAgent, beginTool, checkpointOf, classicTelemetry, decisionsMarkdown, migrateLedger, recordDiscovery, emptyLedger, exportJSON, finishTool, finishTurn, ledgerLines, originOf, reading, recordRequest, receipts, storageLedger, jsonBytes, startRun, UNKNOWN, warn, word, withReplay, usageByTier } from './ledger'
import type { Ledger } from './ledger'
import { replayTimeline, safeFile, STEP_BYTES } from './replay'

import type { Activity, ActivityLog, AgentStrip, AuthState, Credential, EffortLevel, EffortRequest, GitState, GuardFinding, GuardRequest, Meter, Prefs, ReasoningMode, Task, DiscoveryLevel } from '../types'
import { ASSETS, PLAYERS, PLAY_TIMEOUT_MS, clampVolume } from './audio'
import type { Player } from './audio'
import { EMPTY_LOG, EVENT_TTL_MS, callOf, closeOf, liveOf, push } from './activity'
import { activityOf, readBash } from './classify'
import { parseStatus, projectOf } from './git'
import { assessCommand } from './guard'
import {
  addedAttribution,
  attributionInCommand,
  findAttribution,
  instructionFilesWritten,
  isInstructionFile,
  namesInstructionFile,
} from './hygiene'
import type { Attribution } from './hygiene'
import { redactSecrets } from './secrets'
import { EMPTY_GUARD, exhaustedBlocker, bounded as boundedAlerts, decide as decideAlert, dueOf, guardConfigOf, guardText, labelOf as guardLabel, messageOf as alertMessage } from './alerts'
import type { GuardConfig } from './alerts'
import { uidOf, attemptsOf, boundedChecks, configOf as stopConfigOf, hasChangeSummary, hasChanges, outputTail, verdictOf, BLOCKER_PREFIX, type CheckRecord, type StopConfig } from './stopguard'
import { applyAction, blockMilestone, unblock, newTask, noteFailure, oneLine, progressNudge, checkedAt, reopenVerification, setGate, settle, stampGates, summaryOf, touchFile, treeMoved } from './model'
import type { Cue, ProgressInput } from './model'
import { basename, parseShell, unwrap } from './shell'
import { COLORS, fit, heading, hudRows, paneRows, visualStateOf } from './view'
import {
  FOLD_MS,
  STATE_COLOR,
  STATE_LABEL,
  TRACK_H,
  TRACK_W,
  cellsOf,
  fitText,
  layoutOf,
  positionAt,
  secondaryText,
  stripGrid,
  stripSvg,
  trackGrid,
  trackSvg,
  transition,
  visibleAgents,
  visualOf,
} from './progress-visual'
import type { Glide, Visual } from './progress-visual'
import { MICRO, OPERATOR, PANEL_H, PANEL_W, mascotAlt, mascotGrid, mascotSvg } from './mascot'
import { crawlerForm, crawlerGlyph, crawlerSvg, layerOf, positionOf, startupOf, stateOf, STARTUP_STEPS } from './crawler'
import type { CrawlerInput, Motion, NwhoLayer, Observations } from './crawler'
import { NO_NWHO } from './crawler'
import { advance, fieldGrid, fieldRows, fieldSvg, graphOf, RESTING, rowsOf as fieldRowsOf, tapeOf } from './field'
import type { Graph, Tape, Walker } from './field'
import {
  EMPTY_CONTROL,
  controlLabel,
  controlRows,
  cursorAt,
  drain,
  flashStrength,
  fold,
  liveFlash,
  seenAny,
  stripRows,
  stripText,
} from './nwho'
import type { Cursor, Flash, LocalControl, NwhoEvent } from './nwho'
import { paintCrawler } from './progress-visual'
import { API_REFUSAL, authLines, authOf, authRows, settingsSources } from './auth'
import {
  EMPTY_ORCHESTRA,
  admitSpawn,
  hasRole,
  headerText,
  limitOf,
  noteOutcome,
  orchestraRows,
  orchestrationText,
  reviewAdmitted,
  reviewHint,
  reviewVerdict,
  roleOf,
  roleStrip,
  tierOf,
} from './orchestra'
import type { OrchestraView } from './orchestra'
import { BLOCK_DENY, BLOCK_LINE, EMPTY_POLICY, FABLE_RULE, answered, blocked, fableConfigured, fableRoute, isFable } from './policy'
import { isPersonOrigin } from './origin'
import { agentsOf, readCache } from './cache'
import type { CacheReading } from './cache'
import { doctorText, shown as shownPath } from './doctor'
import type { DoctorFacts, Install, StopFacts } from './doctor'
import { dirFor, filesFor, gather, health, healthOf, limits, newSid, prepared, queue as teleQueue, segment, setEnabled as setTelemetry } from './telemetry-store'
import { flowGrid, flowOf, flowRow, flowText, layoutOf as flowLayout } from './flow'
import type { FlowInput, FlowTier } from './flow'
import { agentRole, cleanEvent, encode, expiredFiles, isTelemetryFile, modelTier, monthKey, parseWindow, segmentName, shedFiles, statsCsv, statsJson, statsText, TOTAL_CAP_BYTES } from './telemetry'
import type { HudInput, Row, Segment } from './view'

const PANE = 'cobalt-cockpit'
const TOOL = 'mcp__cobalt-cockpit__progress'
const MIN_VERSION = [2, 1, 287] as const
// The first engine seen to carry the Agent tool's own `effort` parameter. On an
// older one the level is set by the `turn.step` rewrite alone.
const NATIVE_EFFORT_VERSION = [2, 1, 292] as const
const FRAME_MS = 60
const GIT_DEBOUNCE_MS = 400
const GIT_TIMEOUT_MS = 6_000
const TRACK_KEY = 'progress-track'
/** The Activity Field's Raster, blitted from the same loop as the track. */
const FIELD_KEY = 'activity-field'
const FLOW_KEY = 'neural-flow'
const GUARD_HEADER = 'Blast radius'
const PROCEED = 'Proceed'
const CANCEL = 'Cancel'

const IDLE: Activity = { kind: 'IDLE', detail: '', isWorking: false, toolUseId: null, agents: [], at: 0 }
const NO_METER: Meter = { percent: null, tokens: null, window: null, model: null, effort: null }
const DEFAULT_PREFS: Prefs = { isMuted: false, isHudHidden: false }

const taskAtom = atom({ plugin: 'cobalt-cockpit', key: 'task' } as const, null)
const activityAtom = atom({ plugin: 'cobalt-cockpit', key: 'activity' } as const, IDLE)
const gitAtom = atom({ plugin: 'cobalt-cockpit', key: 'git' } as const, null)
const meterAtom = atom({ plugin: 'cobalt-cockpit', key: 'meter' } as const, NO_METER)
const guardsAtom = atom({ plugin: 'cobalt-cockpit', key: 'guards' } as const, [])
const visualAtom = atom({ plugin: 'cobalt-cockpit', key: 'visual' } as const, { waiting: 0, agents: [] as AgentStrip[], revision: 0 })
const prefsAtom = atom({ plugin: 'cobalt-cockpit', key: 'prefs' } as const, DEFAULT_PREFS)
// Local Control: the optional NobodyWho telemetry observed this session, and
// the transient flash the HUD shows while a real receipt is fresh. Both live in
// `$.state`, so a hot reload keeps them and never replays old receipts, because
// the ledger cursor below is module state and deliberately starts at the end.
const controlAtom = atom({ plugin: 'cobalt-cockpit', key: 'control' } as const, EMPTY_CONTROL)
const cursorAtom = atom({ plugin: 'cobalt-cockpit', key: 'control-cursor' } as const, null as Cursor | null)
const flashAtom = atom({ plugin: 'cobalt-cockpit', key: 'flash' } as const, null as Flash | null)
const startupAtom = atom({ plugin: 'cobalt-cockpit', key: 'startup' } as const, [] as string[])
// The Activity Field's tape: the bounded window of real observations the field
// draws and the crawler walks. It lives in `$.state` so a hot reload keeps it,
// and every entry is one event `activity.ts` already reduced to safe fields.
const eventsAtom = atom({ plugin: 'cobalt-cockpit', key: 'events' } as const, EMPTY_LOG)
// The model policy's count, how the session is authenticated, and what
// delegation has come to. All three are facts a drawing reads, so they live in
// `$.state` and a hot reload neither loses a refusal nor forgets a reviewer.
const policyAtom = atom({ plugin: 'cobalt-cockpit', key: 'policy' } as const, EMPTY_POLICY)
const authAtom = atom({ plugin: 'cobalt-cockpit', key: 'auth' } as const, null as AuthState | null)
const orchestraAtom = atom({ plugin: 'cobalt-cockpit', key: 'orchestra' } as const, EMPTY_ORCHESTRA)
// The effort capability this session has really observed, by model id: folded
// in from the engine's own applied level, so a declared baseline is replaced
// only by a fact. It lives in `$.state`, so a hot reload keeps it.
// The session's router: OFF in every fresh session, switched only by /cockpit router, never stored.
/** The discovery level the person pinned with /cockpit discovery; null lets the rules decide. This session only. */
const discoveryPinAtom = atom({ plugin: 'cobalt-cockpit', key: 'discovery-pin' } as const, null as DiscoveryLevel | null)
const routerAtom = atom({ plugin: 'cobalt-cockpit', key: 'router' } as const, EMPTY_ROUTER as RouterState)
const effortKnownAtom = atom({ plugin: 'cobalt-cockpit', key: 'effort-known' } as const, {} as Record<string, readonly EffortLevel[]>)

// Synchronous fence covers the whole awaited commander effect, including path resolution.
const commanderEffects = new Set<symbol>()
const SWARM_TOOL_NAME = 'mcp__cobalt-cockpit__swarm'
const poolBudget = (v: unknown): number | 'AUTO' => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(128,Math.floor(v)) : 'AUTO'
// Operator-declared effort capability, by model id: a level or a list of them.
// Anything else is ignored rather than guessed.
const parseModelEffort = (v: unknown): Record<string, readonly EffortLevel[]> => {
  if (v === null || typeof v !== 'object') return {}
  const out: Record<string, readonly EffortLevel[]> = {}
  for (const [model, levels] of Object.entries(v as Record<string, unknown>)) {
    const allowed = Array.isArray(levels) ? levels.filter(isEffortLevel) : isEffortLevel(levels) ? [levels] : []
    if (allowed.length > 0) out[model] = allowed
  }

  return out
}
const SWARM_TOOL = {
  name: 'swarm', description: 'Commander task ownership and elastic admission. SONNET_LED: action consult requests one Opus consultation (ground, objective, architecture, locations, alternatives, failures, risk, question) and returns the brief for cobalt-cockpit:architect. Assign before Agent; put [task:ID] in Agent description. Queue is commander dispatched: retry Agent after dependencies/resources clear. Result/escalate preserve locks until observed turn completion. No automatic model spawning. Read-only tools may run within declared scope; scoped writers cannot use Bash (declare exclusive * ownership for shell work).',
  inputSchema: { type: 'object', properties: {
    action: { type: 'string', enum: ['assign','status','wave','result','escalate','cancel','verify','resolve','adopt','consult'] },
    ground: { type: 'string', enum: [...GROUNDS], description: 'consult (SONNET_LED): why Opus is needed — architecture, security, repeated-failure, asked or release' },
    architecture: { type: 'string', description: 'consult: the current architecture, briefly' }, alternatives: { type: 'array', items: { type: 'string' }, description: 'consult: approaches considered or already tried' }, failures: { type: 'array', items: { type: 'string' }, description: 'consult: failing output, briefly' },
    task_id: { type: 'string' }, agent_id: { type: 'string', description: 'adopt: existing running host agent ID; commander binds an explicit assignment when old ownership was unavailable' }, tier: { type: 'string', enum: ['OPUS','SONNET','HAIKU'] }, role: { type: 'string' }, objective: { type: 'string' }, scope: { type: 'string' },
    dependencies: { type: 'array', items: { type: 'string' } }, owned_resources: { type: 'array', items: { type: 'string' } }, mode: { type: 'string', enum: ['read','write'] },
    parent_task: { type: 'string' }, spawn_reason: { type: 'string' }, wave: { type: 'string', enum: ['RECONNAISSANCE','ENGINEERING','REVIEW','INTEGRATION','VERIFICATION'] },
    conclusion: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } }, changes: { type: 'array', items: { type: 'string' } }, verification: { type: 'array', items: { type: 'string' } }, unresolved: { type: 'array', items: { type: 'string' } }, confidence: { type: 'string' },
    to: { type: 'string', enum: ['SONNET','OPUS'] }, discoveries: { type: 'array', items: { type: 'string' } }, question: { type: 'string' }, risk: { type: 'string' }, next_action: { type: 'string' }, locations: { type: 'array', items: { type: 'string' } }, state: { type: 'string', enum: ['pending','pass','fail','unknown'] }, release_outcome: { type: 'string', enum: ['go','no-go'], description: 'verify (a release consultation, state pass): your confirmation of the architect\'s own DECISION line; it cannot be more favourable than that line' },
    effort: { type: 'string', enum: ['AUTO','low','medium','high','xhigh','max'], description: 'assign/escalate: the reasoning level this task deserves, or AUTO to choose from the task' }, effort_reason: { type: 'string', description: 'assign/escalate: why that level was chosen' },
  }, required: ['action'] },
} as const
// Canonicalize both assignment and use. Unknown aliases conservatively lock all.
const canonicalResource = async ($: EngineInterface, path: string): Promise<string> => {
  // `~` is the engine's to expand, not a directory under cwd: it is unknown, so everything.
  if (!path || /[*?\[\]{}]/.test(path) || path.startsWith('~')) return '*'
  try {
    const r = await $.process.run(['realpath','-m','--', path.startsWith('/') ? path : `${cwd}/${path}`], { timeoutMs: 2000 })
    return r.exitCode === 0 && !r.isStdoutTruncated ? normalizeOwned(r.stdout.trim()) : '*'
  } catch { return '*' }
}
const swarmState = (l: Ledger): Swarm => l.swarm ?? emptySwarm()
const changeSwarm = async ($: EngineInterface, f: (s: Swarm) => Swarm): Promise<Swarm> => {
  const l = await update($, ledgerAtom, old => ({ ...old, schema: 2 as const, swarm: f(swarmState(old)) }))
  return l.swarm!
}
const finishObserved = (s: Swarm, id: string, reason: string, conclusion: string, at: number): Swarm => {
  const task = s.tasks.find(t=>t.id===id)
  if (!task) return s
  s = { ...s, tasks: s.tasks.map(t => t.id === id ? { ...t, resultDelivery: t.resultDelivery ?? (conclusion.trim() && conclusion !== 'unknown' && conclusion !== 'Host reports stopped; result unavailable' ? 'answer_observed' as const : 'unavailable' as const) } : t) }
  const result = task.result ?? { conclusion, unresolved:['Structured result unavailable; commander verification pending'] }
  const state = task.cancellationRequested || ['aborted','cancelled'].includes(reason) ? 'cancelled' : ['answer','completed'].includes(reason) ? 'completed' : 'failed'
  try { return finishTask(s,id,state,result,at) } catch {
    return finishTask(s,id,'failed',{ ...result, unresolved:[...('unresolved' in result ? result.unresolved : []),'Host stopped with unresolved dependencies/child work; completion rejected'] },at)
  }
}
/**
 * The commit a release review is for: the full id of HEAD, and only when the working tree is clean (every
 * untracked file and submodule counted, whatever the user's git configuration says), because a review of a
 * commit says nothing of changes that are not in it. `dirty` is a real difference; `unknown` is git failing.
 */
type Candidate = { sha: string } | { sha: null; why: 'dirty' | 'unknown' }
const candidateOf = async ($: EngineInterface): Promise<Candidate> => {
  try {
    const run = (argv: string[]) => $.process.run(['git', '--no-optional-locks', ...argv], { timeoutMs: GIT_TIMEOUT_MS })
    const head = await run(['rev-parse', '--verify', 'HEAD'])
    if (head.exitCode !== 0 || head.isStdoutTruncated) return { sha: null, why: 'unknown' }
    const status = await run(['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'])
    if (status.exitCode !== 0 || status.isStdoutTruncated) return { sha: null, why: 'unknown' }
    if (status.stdout.trim() !== '') return { sha: null, why: 'dirty' }
    const sha = head.stdout.trim()

    return isCandidate(sha) ? { sha } : { sha: null, why: 'unknown' }
  } catch {
    return { sha: null, why: 'unknown' }
  }
}
const releaseRecords = (held: unknown): ReleaseRecord[] => (Array.isArray(held) ? held.filter((h): h is ReleaseRecord => h !== null && typeof h === 'object' && isCandidate((h as ReleaseRecord).candidate) && typeof (h as ReleaseRecord).id === 'string' && typeof (h as ReleaseRecord).returned === 'boolean' && typeof (h as ReleaseRecord).at === 'number').map(h => {
  // a verdict is kept only in its two known forms; anything else reads as no verdict, which never approves
  const { verified, outcome, ...rest } = h
  return { ...rest, ...(verified === 'pass' || verified === 'fail' ? { verified } : {}), ...(outcome === 'go' || outcome === 'no-go' ? { outcome } : {}) }
}) : [])
/** The store's release records. Strict: a store that cannot be read, or holds something else, fails a release request closed. */
const releaseHistory = async ($: EngineInterface): Promise<ReleaseRecord[]> => {
  const held = await $.store.get('release-reviews')
  if (held !== undefined && !Array.isArray(held)) throw new Error('OPUS / RELEASE RECORD UNREADABLE. The stored record of release reviews is not usable, so the allowance cannot be established. Nothing was started.')

  return releaseRecords(held)
}
/** The same, for housekeeping: what can be read. */
const releaseHistorySoft = async ($: EngineInterface): Promise<ReleaseRecord[]> => releaseRecords(await $.store.get('release-reviews').catch(() => undefined))
/**
 * Every write of the release records goes through here, one at a time inside this process: the list is read again
 * inside the queue, changed, written, and read back, and a record that did not come back as written fails the
 * operation (so an admission that depends on it admits nothing). LIMIT: the store offers get and set only, with no
 * compare-and-set, so two Cockpit processes sharing one store can still overwrite each other between the read and the
 * write. The read-back catches a write that is already gone, not one that is lost a moment later; the merge by id and
 * the read-again keep what a second process wrote earlier. A release admission is the one place that cannot be left
 * ambiguous, and it fails closed on any mismatch.
 */
let releaseQueue: Promise<unknown> = Promise.resolve()
const mutateRelease = ($: EngineInterface, f: (held: ReleaseRecord[]) => ReleaseRecord[]): Promise<ReleaseRecord[]> => {
  const run = releaseQueue.then(async () => {
    const held = await releaseHistory($)
    const written = f(held)
    if (JSON.stringify(written) === JSON.stringify(held)) return held
    await $.store.set('release-reviews', written)
    const back = releaseRecords(await $.store.get('release-reviews'))
    const lost = written.find(n => { const b = back.find(x => x.id === n.id); return b === undefined || b.candidate !== n.candidate || b.returned !== n.returned || b.verified !== n.verified || b.outcome !== n.outcome })
    if (lost !== undefined) throw new Error(`OPUS / RELEASE RECORD NOT PERSISTED. The record of release consultation ${lost.id} did not read back as written, so nothing that depends on it was started.`)

    return written
  })
  releaseQueue = run.catch(() => undefined)

  return run
}
/** A release consultation the host saw return is recorded as returned where a restart cannot lose it, whether or not it has been verified yet. */
const syncRelease = async ($: EngineInterface): Promise<void> => {
  const ledger = await read($, ledgerAtom)
  const swarm = swarmState(ledger)
  const back = (ledger.consults ?? []).filter(c => c.ground === 'release' && c.candidate !== undefined && hasReturned(swarm.tasks.find(t => t.id === c.id)))
  if (back.length === 0) return
  await mutateRelease($, held => back.reduce((all, c) => (all.some(h => h.id === c.id && h.returned) ? all : withRelease(all, { candidate: c.candidate!, id: c.id, at: c.requestedAt, returned: true })), held))
}
/**
 * A release approval stands only for the commit it was given for, on a clean tree: a change takes it back, and the
 * same commit, clean again, gives it back from the stored record of a verified GO (`revalidateRelease`). A git that
 * does not answer grants nothing and restores nothing; an approval already held is kept, since nothing shows it moved,
 * and the stored records are never touched.
 */
const reconcileRelease = async ($: EngineInterface): Promise<void> => {
  const task = await read($, taskAtom)
  const review = task?.review
  if (review === undefined || !review.grounds.includes('release')) return
  const history = await releaseHistorySoft($)
  // nothing held and nothing stored that could stand for a commit: git need not be asked
  if (review.cleared?.some(x => x.ground === 'release') !== true && review.state !== 'adjudicated' && !history.some(h => h.returned && h.verified === 'pass' && h.outcome === 'go')) return
  const revalidated = revalidateRelease(review, await candidateOf($), history)
  if (revalidated === review) return
  const was = JSON.stringify(review)
  await update($, taskAtom, t => (t?.review !== undefined && JSON.stringify(t.review) === was ? settle({ ...t, review: revalidated }).task : t))
}

/**
 * One Opus consultation requested by the main session (SONNET_LED). The ground
 * and packet are checked by `consultVerdict` alone; no router is asked. Admission
 * reserves nothing yet: the OPUS swarm task it submits is admitted again, with
 * ownership and budget, when the architect's Agent call arrives.
 */
let consulting: Promise<unknown> = Promise.resolve()
/** One consultation request at a time: two cannot both pass the bounds before either is recorded. */
const serveConsult = ($: EngineInterface, e: Record<string, unknown>, at: number): Promise<string> => {
  const run = consulting.then(() => serveConsultNow($, e, at), () => serveConsultNow($, e, at))
  consulting = run.catch(() => undefined)

  return run
}
const serveConsultNow = async ($: EngineInterface, e: Record<string, unknown>, at: number): Promise<string> => {
  const ground = e['ground']
  if (!isGround(ground)) throw new Error(`Valid ground required: ${GROUNDS.join(', ')}`)
  const made = packetOf(ground, { objective: e['objective'], architecture: e['architecture'], files: e['locations'], alternatives: e['alternatives'], failures: e['failures'], risk: e['risk'], decision: e['question'] })
  if ('error' in made) throw new Error(`Evidence packet incomplete: ${made.error}`)
  const task = await read($, taskAtom)
  const facts = factsOf(task, (await read($, orchestraAtom)).errorStreak, task?.promptGrounds ?? [])
  const ledger = await read($, ledgerAtom)
  const consults = ledger.consults ?? []
  if (ground === 'release') {
    await syncRelease($)
    // a verified GO already held for this exact clean commit is applied to this task before the duplicate is refused
    await quiet(() => reconcileRelease($))
  }
  const candidate = ground === 'release' ? (await candidateOf($)).sha : null
  const history = ground === 'release' ? await releaseHistory($) : []
  const verdict = consultVerdict({ profile: config.hasOrchestration ? config.profile : 'OPUS_LED', ground, packet: made.packet, facts, consults, swarm: swarmState(ledger), progressTask: task?.id ?? null, candidate, history })
  if (!verdict.ok) {
    await quiet(() => mutateLedger($, l => warn(l, `${verdict.reason.split('.')[0]} (${ground})`)))
    await tele($, { k: 'consult', ground, ev: 'refused' })
    throw new Error(verdict.reason)
  }
  // The architect reads the files the packet names (line references dropped),
  // inside the project only; a packet that names none reads the project, never `*`.
  const root = await canonicalResource($, cwd || '.')
  if (root === '*') throw new Error('OPUS / the project root could not be resolved, so no read scope can be given; nothing was admitted')
  const named = await Promise.all(readScopeOf(made.packet).map(p => canonicalResource($, p)))
  const owned = named.filter(p => p !== '*' && (p === root || p.startsWith(`${root}/`)))
  const outside = named.length - owned.length
  // The path lookups take time: another consultation may have been
  // admitted meanwhile, so the bounds are checked again on the ledger as it is now.
  const fresh = await read($, ledgerAtom)
  // the candidate is read again as well: it is the commit the review is for, and it must still be the one
  const nowCandidate = ground === 'release' ? (await candidateOf($)).sha : null
  const fresher = ground === 'release' ? await releaseHistory($) : []
  const again = consultVerdict({ profile: config.hasOrchestration ? config.profile : 'OPUS_LED', ground, packet: made.packet, facts, consults: fresh.consults ?? [], swarm: swarmState(fresh), progressTask: task?.id ?? null, candidate: nowCandidate, history: fresher })
  if (!again.ok) { await tele($, { k: 'consult', ground, ev: 'refused' }); throw new Error(again.reason) }
  if (nowCandidate !== candidate) throw new Error('OPUS / CANDIDATE CHANGED. The commit moved or the working tree changed while the consultation was being admitted; nothing was started. Ask again for the commit you mean.')
  const counter = (list: readonly { id: string }[]) => Math.max(0, ...list.map(x => Number(/^opus-(\d+)-/.exec(x.id)?.[1] ?? 0)))
  // unique across the ledger and the store, so a restart cannot reuse the id of an attempt already spent
  const id = `opus-${Math.max(counter(fresh.consults ?? []), counter(fresher)) + 1}-${verdict.key.slice(0, 6)}`
  // the record that bounds a release review is written first, and a write that fails admits nothing
  if (ground === 'release' && nowCandidate !== null) await mutateRelease($, held => withRelease(held, { candidate: nowCandidate, id, at, returned: false }))
  await changeSwarm($, held => submitTask(held, { id, tier: 'OPUS', role: ground === 'release' || ground === 'security' ? 'REVIEW' : 'ARCHITECT', objective: made.packet.decision, scope: `Opus consultation · ${ground}`, owned: owned.length ? owned : [root], mode: 'read', parentTask: null, effort: CONSULT_EFFORT, effortReason: `Opus consultation: ${CONSULT_EFFORT} by default`, spawnReason: `Opus admitted on ${ground}${verdict.isMandatory ? ' (mandatory)' : ''}` }, at).swarm)
  const c: Consultation = { id, ground, key: verdict.key, packet: made.packet, progressTask: task?.id ?? null, isMandatory: verdict.isMandatory, requestedAt: at, ...(ground === 'release' && candidate !== null ? { candidate } : {}) }
  await mutateLedger($, l => ({ ...l, consults: addConsult(l.consults ?? [], c) }))
  // A review is advanced only by a consultation on one of the grounds that made
  // it necessary: an easier consultation on another ground does not stand in for it.
  if (task !== null) await change($, t => {
    if (t.id !== task.id) return t
    const held = verdict.isMandatory ? requireReview(t, [ground]) : t
    // an approval given for another commit was withdrawn above (`reconcileRelease`); an attempt carries no commit
    // onto the review, only a cleared release ground does (`advanceReview`, `clearReview`)
    const admitted = held.review?.grounds.includes(ground) ? advanceReview(held.review, id, 'admitted') : undefined

    return admitted === undefined ? held : { ...held, review: admitted }
  })

  await tele($, { k: 'consult', ground, ev: 'admitted', mandatory: verdict.isMandatory })
  const scope = `Read scope: ${owned.length ? `${owned.length} named file${owned.length === 1 ? '' : 's'}` : 'the project'}${outside ? `; ${outside} location${outside === 1 ? '' : 's'} not readable (outside the project, home-relative or not a plain path)` : ''}.`

  return `OPUS ADMITTED / ${id} · ${ground}${verdict.isMandatory ? ' · mandatory for this task' : ''}. ${scope}\nSpawn Agent with subagent_type "cobalt-cockpit:architect", description "[task:${id}] Opus ${ground} consultation", and exactly this brief as the prompt:\n\n${briefOf(c)}\n\nIts answer is advice until you verify it. Then record swarm action "verify" for ${id}: pass when the advice checks out, fail when it does not, with evidence either way.`
}
const serveSwarm = async ($: EngineInterface, e: Record<string, unknown>): Promise<{ result: string; isError?: boolean }> => {
  try {
    const action = String(e['action'] ?? ''), id = String(e['task_id'] ?? ''), agent = typeof e['agentId'] === 'string' ? e['agentId'] : undefined
    const at = await $.clock.now()
    const str = (k: string) => textOf(e[k])
    const list = (k: string) => Array.isArray(e[k]) ? (e[k] as unknown[]).filter((v): v is string => typeof v === 'string').slice(0, 64).map(textOf) : []
    const s = await changeSwarm($, held => markStalled(held,at)); const task = s.tasks.find(t => t.id === id)
    if (agent && (!task || task.agentId !== agent || !['result','escalate','status'].includes(action))) throw new Error('Only commander assigns, verifies, cancels or changes waves; agents report their own task only')
    if (action === 'status') {
      const selected = id ? s.tasks.filter(t=>t.id===id) : [...s.tasks.filter(t=>!['completed','failed','cancelled'].includes(t.state)), ...s.tasks.filter(t=>['completed','failed','cancelled'].includes(t.state)).slice(-8)].slice(0,32)
      return { result: JSON.stringify({ ...summarizeSwarm(s), tasks: selected.map(t => ({ id:t.id, tier:t.tier, role:t.role, state:t.state, reason:t.reason, agent:t.agentId, effort:t.requestedEffort, launchEffort:t.launchEffort ?? null, appliedEffort:t.appliedEffort, effortReason:t.effortReason, result:t.result ? { conclusion:t.result.conclusion.slice(0,160), evidence:t.result.evidence.slice(0,3).map(x=>x.slice(0,160)), unresolved:t.result.unresolved.slice(0,3).map(x=>x.slice(0,160)) } : null, escalation:t.escalation ? { to:t.escalation.to, effort:t.escalation.effort ?? null, question:t.escalation.question.slice(0,160), risk:t.escalation.risk.slice(0,160) } : null, verification:t.verification, resultDelivery:t.resultDelivery ?? 'unavailable' })) }) }
    }
    if (action === 'assign') {
      if (typeof e['objective'] !== 'string' || !e['objective'].trim()) throw new Error('Bounded objective required')
      if (!/^[\w.-]{1,80}$/.test(id) || !['OPUS','SONNET','HAIKU'].includes(String(e['tier']))) throw new Error('Valid task_id and tier required')
      if (e['tier'] === 'OPUS' && isSonnetLed()) throw new Error('OPUS / in SONNET_LED an Opus task is admitted only through action consult, with a ground and an evidence packet')
      const owned = await Promise.all(list('owned_resources').map(p => canonicalResource($, p)))
      const assignedSwarm = await changeSwarm($, held => { const submitted = submitTask(held, { id, tier: e['tier'] as ModelTier, role: str('role'), objective: str('objective'), scope: str('scope'), dependencies:list('dependencies'), owned, mode: e['mode'] === 'write' ? 'write' : 'read', parentTask: typeof e['parent_task'] === 'string' ? e['parent_task'] : null, spawnReason: str('spawn_reason'), ...(isEffortRequest(e['effort']) ? { effort: e['effort'] } : {}), ...(typeof e['effort_reason'] === 'string' ? { effortReason: str('effort_reason') } : {}) }, at).swarm; if (jsonBytes(submitted.tasks.map(t=>({ ...t,result:null,escalation:null }))) > 192_000) throw new Error('Ownership metadata storage budget reached; finish/archive work before assigning more'); return submitted })
      const assigned = assignedSwarm.tasks.find(t => t.id === id)
      return { result: assigned ? `Task ${id} ${assigned.state}; use Agent description [task:${id}]. OPUS tasks stay in main.` : 'Duplicate suppressed; see swarm status for existing task.' }
    }
    if (action === 'consult') { const reply = await serveConsult($, e, at); await persist($); return { result: reply } }
    if (action === 'wave') { if (!['RECONNAISSANCE','ENGINEERING','REVIEW','INTEGRATION','VERIFICATION'].includes(String(e['wave']))) throw new Error('Valid wave required'); await changeSwarm($, held => setWave(held, e['wave'] as Wave, at)) }
    else {
      if (!task) throw new Error('Unknown task')
      if (action === 'adopt') {
        if (task.tier === 'OPUS') throw new Error('OPUS / a consultation runs only as the cobalt-cockpit:architect spawned for its [task:ID]; an existing agent cannot be adopted into it')
        const existingId = String(e['agent_id'] ?? '')
        const listed = await $.agent.list()
        if (!listed.some(a=>a.id===existingId && a.status==='running')) throw new Error('Adoption requires an observed running host agent')
        await changeSwarm($, held => { const admitted = admitTask(held,id,at); if (!admitted.ok) throw new Error(admitted.reason!); return bindAgent(admitted.swarm,id,existingId,at,'adopt') })
      } else if (action === 'result') {
        await changeSwarm($, held => {
          let chain = held
          if (task.tier === 'OPUS' && (held.config.opus ?? 0) === 0 && ['queued','blocked'].includes(task.state)) { const admitted = admitTask(held,id,at); if (!admitted.ok) throw new Error(admitted.reason!); chain = admitted.swarm }
          chain = reportResult(chain, id, { conclusion:str('conclusion'), evidence:list('evidence'), changes:list('changes'), verification:list('verification'), unresolved:list('unresolved'), confidence: typeof e['confidence'] === 'string' ? str('confidence') : null }, at)
          return task.tier === 'OPUS' && (held.config.opus ?? 0) === 0 ? finishTask(chain,id,'completed',chain.tasks.find(t=>t.id===id)!.result,at) : chain
        })
      } else if (action === 'escalate') {
        if (!['SONNET','OPUS'].includes(String(e['to']))) throw new Error('Valid escalation destination required')
        await changeSwarm($, held => escalateTask(held,id,{ objective: task.objective, discoveries:list('discoveries'), evidence:list('evidence'), question:str('question'), risk:str('risk'), nextAction:str('next_action'), locations:list('locations'), to:e['to'] as ModelTier, effort: isEffortLevel(e['effort']) ? e['effort'] : null, effortReason: typeof e['effort_reason'] === 'string' ? str('effort_reason') : null },at))
      } else if (action === 'resolve') await changeSwarm($, held => resolveEscalation(held,id,{ conclusion:str('conclusion'),evidence:list('evidence'), changes:list('changes'), verification:list('verification'), unresolved:list('unresolved') },at))
      else if (action === 'cancel') await changeSwarm($, held => requestCancel(held,id,at))
      else if (action === 'verify') { if (!['pending','pass','fail','unknown'].includes(String(e['state']))) throw new Error('Valid verification state required')
        // A consultation's advice can be judged, pass or fail, only once Opus has given it.
        const consult = (await read($, ledgerAtom)).consults?.find(c => c.id === id)
        const judged = e['state'] === 'pass' || e['state'] === 'fail'
        // a recorded release recommendation is final: it is not judged again, so nothing can turn a NO-GO into a GO
        if (consult?.ground === 'release' && judged && (await releaseHistory($)).some(h => h.id === id && h.outcome !== undefined)) throw new Error('OPUS / RELEASE VERDICT RECORDED. This release consultation already has its recommendation recorded and it is final. Ask again only on a changed commit.')
        if (consult && judged && !hasReturned(task)) throw new Error('OPUS / this consultation has not returned. Spawn cobalt-cockpit:architect with its [task:ID] and let it answer; a review is adjudicated only on an answer Opus gave')
        // A release ground is cleared by a recommendation, not by the advice being sound. The recommendation is the
        // architect's own DECISION line; `release_outcome` is the main session confirming it, and can only be as
        // strict or stricter. A missing, repeated, hedged or contradicted one records and clears nothing.
        let outcome: ReleaseOutcome | undefined
        if (consult?.ground === 'release' && e['state'] === 'pass') {
          const said = task.agentId === null ? undefined : (await read($, ledgerAtom)).observedCompletions?.find(c => c.agentId === task.agentId)?.decision
          if (said === undefined) throw new Error('OPUS / RELEASE DECISION UNREADABLE. The architect\'s returned answer does not carry exactly one line "DECISION: GO" or "DECISION: NO-GO", so no release recommendation can be read from it. Nothing was recorded. Verify it with state "fail", or ask again on a changed commit.')
          const asked = e['release_outcome']
          if (asked !== 'go' && asked !== 'no-go') throw new Error('OPUS / release_outcome required: "go" or "no-go", confirming the architect\'s DECISION line. A verified pass alone approves nothing. Nothing was recorded.')
          if (asked === 'go' && said === 'no-go') throw new Error('OPUS / the architect\'s DECISION is NO-GO; a GO cannot be declared over it. Verify with release_outcome "no-go". Nothing was recorded.')
          outcome = asked === 'go' && said === 'go' ? 'go' : 'no-go'
        }
        // the record a later task or a restart relies on is written first; a write that does not read back stops here
        if (consult?.ground === 'release' && consult.candidate !== undefined && judged) await mutateRelease($, held => withRelease(held, { candidate: consult.candidate!, id, at: consult.requestedAt, returned: true, verified: e['state'] as 'pass' | 'fail', ...(outcome === undefined ? {} : { outcome }) }))
        await changeSwarm($, held => verifyTask(held,id,e['state'] as Verification,at,list('evidence').join('; ')))
        // The main session judging a consultation's advice clears the one ground that consultation was asked on, and no other.
        if (consult && judged) {
          const now = consult.ground === 'release' ? (await candidateOf($)).sha : null
          await change($, t => t.review ? { ...t, review: clearReview(t.review, consult, e['state'] as 'pass' | 'fail', outcome, now) } : t)
          await tele($, { k: 'consult', ground: consult.ground, ev: 'verified', state: e['state'], ...(outcome === undefined ? {} : { rel: outcome }) })
        }
        // a release consultation that really returned is recorded as such where a restart cannot lose it
        await quiet(() => syncRelease($))
      }
      else throw new Error('Unknown swarm action')
    }
    await persist($)
    return { result: `Swarm ${action} recorded; host completion and commander verification remain distinct.` }
  } catch (error) { return { result: `SWARM / ${error instanceof Error ? error.message : 'invalid input'}`, isError: true } }
}
// Bounded inspection shell compatibility. No substitutions, redirects, wrappers,
// output flags or arbitrary commands; scoped writes still require Edit/Write.
const readOnlyShell = (command: string): boolean => {
  if (/[<>`\n]/.test(command) || command.includes('$') || /--(?:output|ext-diff|textconv)|--no-index/.test(command)) return false
  try {
    const parsed = parseShell(command)
    if (!parsed.pipelines.length || parsed.substitutions.length) return false
    return parsed.pipelines.every(p => p.commands.every(c => {
      const r = unwrap(c.argv)
      return !!r && r.program === 'git' && ['diff','status','log','show','ls-files','rev-parse','grep'].includes(r.args[0] ?? '') && !r.args.some(a=>a === '-c' || a.startsWith('--output') || a === '--exec' || a === '--help' || a === '-h' || a.startsWith('--open') || a.startsWith('-O') || a.startsWith('--out') || a.startsWith('--ext') || a.startsWith('--text')) && r.wrappers.length === 0 && c.argv[0] === 'git'
    }))
  } catch { return false }
}
/**
 * Sets the reasoning level on an Agent call natively, on the tool's own
 * `effort` parameter: one subagent's level, for that call alone. It overrides
 * the agent definition's frontmatter, the engine clamps it under its own caps
 * and overrides, and the level the engine resolves is what it then reports.
 *
 * The level is the one the assignment names, else one the commander put on the
 * call by hand, else AUTO's choice (the fixed tier level in MANUAL), under the
 * operator ceiling and the model's known capability. A call it leaves alone
 * (MANUAL names no level for Haiku) runs at the engine's own.
 */
const launchEffort = async ($: EngineInterface, call: Record<string, unknown>): Promise<void> => {
  const useId = typeof call['tool_use_id'] === 'string' ? call['tool_use_id'] : ''
  const type = String(call['subagent_type'] ?? '')
  if (useId === '' || type === 'fork') return
  const id = /\[task:([\w.-]+)\]/.exec(String(call['description'] ?? ''))?.[1]
  const task = id === undefined ? undefined : swarmState(await read($, ledgerAtom)).tasks.find(t => t.id === id)
  // the tier and the work an unassigned call gets are the ones `agent.spawn` gives it
  const role = roleOf(type)
  const tier: SubagentTier = task?.tier === 'OPUS' && isSonnetLed() ? 'OPUS' : (task ? task.tier === 'HAIKU' : tierOf(String(call['model'] ?? '')) === 'HAIKU' || role === 'SCOUT' || role === 'UTILITY') ? 'HAIKU' : 'SONNET'
  const facts: EffortFacts = { tier, ...(task ? factsFromRole(task.role, task.mode) : factsFromRole(role, ['EXPLORER', 'RESEARCHER', 'REVIEWER', 'SCOUT', 'UTILITY'].includes(role) ? 'read' : 'write')) }
  const onCall = isEffortLevel(call['effort']) ? call['effort'] : null
  const assigned = task !== undefined && task.requestedEffort !== 'AUTO' ? task.requestedEffort : null
  const named = assigned ?? onCall
  const fixed = desiredRequest('agent', tier, config.profile).effort
  if (config.reasoningMode === 'MANUAL' && named === null && !isEffortLevel(fixed)) return
  const requested: EffortRequest = named ?? (config.reasoningMode === 'MANUAL' && isEffortLevel(fixed) ? fixed : 'AUTO')
  const resolution = chooseEffort(requested, facts, capabilityOf(MODEL_FOR[tier], await read($, effortKnownAtom)), config.maxEffort)
  if (resolution.applied === undefined) return
  call['effort'] = resolution.applied
  launches.set(useId, { level: resolution.applied, named: assigned === null ? onCall : null })
  for (const old of [...launches.keys()].slice(0, -LAUNCHES_MAX)) launches.delete(old)
}
/**
 * What can be seen of where the main loop's level comes from: the variable, a
 * `/effort` typed this session, and the level and cap the settings hold for
 * the model. Read once a turn; nothing is written. `--effort`, a level picked
 * in the model picker and the model's default are not visible to a plugin, and
 * nothing is claimed about them.
 */
const hostSignals = async ($: EngineInterface, turnId: string, model: string): Promise<HostEffortSignals> => {
  if (hostSignalsAt?.turnId === turnId) return hostSignalsAt.signals
  let env: string | undefined
  let held: { level: string | null; cap: string | null } = { level: null, cap: null }
  try { env = await $.env.get('CLAUDE_CODE_EFFORT_LEVEL') } catch { /* no environment to read: nothing is claimed about it */ }
  try { held = settingsEffort(await $.settings.read(), model) } catch { /* no settings to read: nothing is claimed about them */ }
  const signals: HostEffortSignals = { env, command: effortCommand, settings: held.level, cap: held.cap }
  hostSignalsAt = { turnId, signals }

  return signals
}
/**
 * The task a subagent's request belongs to. A subagent's first request can
 * arrive before its spawn has bound it to its task; the task is then found by
 * the id its Agent call's description carries, so that request runs at the
 * task's level like every later one instead of at the tier's baseline.
 */
const taskOfAgent = async ($: EngineInterface, agentId: string): Promise<SwarmTask | undefined> => {
  const tasks = swarmState(await read($, ledgerAtom)).tasks
  const bound = tasks.find(t => t.agentId === agentId)
  if (bound !== undefined || !config.hasOrchestration) return bound
  const listed = (await $.agent.list().catch(() => [])).find(a => a.id === agentId)
  const id = /\[task:([\w.-]+)\]/.exec(listed?.description ?? '')?.[1]

  return id === undefined ? undefined : tasks.find(t => t.id === id && t.agentId === null && !['completed', 'failed', 'cancelled'].includes(t.state))
}
const guardSwarm = async ($: EngineInterface, e: Record<string, unknown>): Promise<string | null> => {
  if (!config.hasOrchestration) return null
  const agent = typeof e['agentId'] === 'string' ? e['agentId'] : undefined
  const s = swarmState(await read($, ledgerAtom)), task = s.tasks.find(t => t.agentId === agent && agent !== undefined)
  if (task?.cancellationRequested) return 'SWARM / cancellation requested; awaiting observed termination'
  const observedAt = await $.clock.now()
  if (task) await changeSwarm($, held => heartbeat(held,task.id,observedAt))
  const tool = String(e['tool'])
  if (tool === SWARM_TOOL_NAME || tool === TOOL) return null
  if (agent && !task) return 'SWARM / agent has no bound ownership; commander must assign before further tools'
  // Host control has no resource effects. Discovery grants no execution rights:
  // each discovered tool still passes its own ownership/native permission guard.
  // Handback returns only this bound helper's report to its native parent.
  if (tool === 'ToolSearch' || (agent && tool === 'SubagentHandback')) return null
  if (agent && (tool === 'Agent' || tool === 'Task')) return 'SWARM / only commander delegates; escalate instead'
  const write = ['Edit','Write','MultiEdit','NotebookEdit'].includes(tool)
  if (!agent && ['Agent','Task','TaskOutput','TaskStop','SendMessage'].includes(tool)) return null
  const readTool = ['Read','Grep','Glob','WebFetch','WebSearch'].includes(tool) || (tool === 'Bash' && readOnlyShell(String(e['command'] ?? '')))
  if (task && task.mode === 'read' && !readTool) return 'SWARM / read-only tasks may use inspection tools only; shell/custom effects require commander investigation'
  if (task && ['Read','Grep','Glob'].includes(tool)) {
    // Grep and Glob without a path search the working directory: that is the claim checked, not everything.
    const path = String(e['file_path'] ?? e['path'] ?? (tool !== 'Read' && cwd ? cwd : '*'))
    // A pattern reaches only below that path: one that is absolute, home-relative or climbs out is refused.
    const pattern = tool === 'Glob' ? e['pattern'] : tool === 'Grep' ? e['glob'] : undefined
    if (typeof pattern === 'string' && !task.owned.includes('*') && /(?:^|[{,])\s*[\/~]|(?:^|[\/\\{,])\.\.(?:[\/\\},]|$)/.test(pattern.trim())) return 'SWARM / read outside owned resources: give the directory as path and a pattern relative to it'
    if (!ownershipAllows(s,task.id,await canonicalResource($,path),'read')) return 'SWARM / read outside owned resources'
  }
  if (task && tool === 'Bash' && !task.owned.includes('*')) return 'SWARM / shell inspection requires declared wildcard read scope'
  if (write) {
    const paths = tool === 'MultiEdit' && Array.isArray(e['edits']) ? (e['edits'] as Record<string,unknown>[]).map(x=>String(x['file_path'] ?? e['file_path'] ?? '')) : [String(e['file_path'] ?? e['notebook_path'] ?? '')]
    for (const path of paths) {
      const canonical = await canonicalResource($,path)
      if (task && !ownershipAllows(s,task.id,canonical)) return 'SWARM / write outside owned resources'
      if (!task && s.tasks.some(t=>t.tier !== 'OPUS' && t.endedAt === null && (['reserved','running'].includes(t.state) || (!['completed','failed','cancelled'].includes(t.state) && (t.agentId !== null || t.startedAt !== null))) && t.owned.some(p=>overlaps(p,canonical)))) return 'SWARM / commander write conflicts with active ownership'
    }
  } else if (!readTool) {
    if (task && !task.owned.includes('*')) return 'SWARM / shell/custom tools require exclusive wildcard ownership'
    if (!task && s.tasks.some(t=>t.tier !== 'OPUS' && t.endedAt === null && (['reserved','running'].includes(t.state) || (!['completed','failed','cancelled'].includes(t.state) && (t.agentId !== null || t.startedAt !== null))))) return 'SWARM / shell/custom effects held until active ownership releases'
  }
  return null
}

const PROGRESS_TOOL = {
  name: 'progress',
  description:
    'Reports real task progress to the Cobalt Cockpit HUD the user watches. ' +
    'action "plan": define the milestones of a substantial task before editing (3-7, in order, each with a phase; kind "coding" or "readonly"; replan true only to refine the current plan). ' +
    '"start" / "complete" / "fail" / "block" / "unblock": move one milestone (by id such as m2, or title); give "note" for fail and block. ' +
    '"gate": report a verification gate (CODE, TEST, TYPE, BUILD, SECURITY, GIT) as pass, fail, na or pending with one line of "evidence"; or several at once in "gates". ' +
    '"discover": for a multi-file or risky task, record the objective, acceptance "criteria", material "unknowns" and relevant "risks". ' +
    '"decide": record one consequential decision as "decision" {problem, chosen, alternatives[{option, rejected_because}], tradeoffs, evidence[], status}. ' +
    '"align": before DONE, check the result against the original request as "alignment" {state ALIGNED|PARTIAL|BLOCKED|UNKNOWN, demonstrated[{id, evidence}], missing[], assumptions[]}; ALIGNED needs evidence per criterion. ' +
    '"status": read the current state. ' +
    'Progress is completed milestones over all milestones; 100% needs every milestone complete and every required gate pass or na. Never complete a milestone that is not finished.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['plan', 'start', 'complete', 'fail', 'block', 'unblock', 'gate', 'discover', 'decide', 'align', 'status'] },
      goal: { type: 'string', description: 'plan: the task in one line' },
      kind: { type: 'string', enum: ['coding', 'readonly'], description: 'plan: readonly tasks need no verification gates' },
      milestones: {
        type: 'array',
        description: 'plan: the milestones in order',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            phase: { type: 'string', enum: ['RESEARCH', 'PLAN', 'IMPLEMENT', 'TEST', 'FIX', 'VERIFY'] },
          },
          required: ['title'],
        },
      },
      replan: { type: 'boolean', description: 'plan: keep the state of milestones whose titles are kept' },
      milestone: { type: 'string', description: 'start/complete/fail/block: the milestone id (m1, m2, ...) or title' },
      gate: { type: 'string', enum: ['CODE', 'TEST', 'TYPE', 'BUILD', 'SECURITY', 'GIT'] },
      state: { type: 'string', enum: ['pass', 'fail', 'na', 'pending'] },
      evidence: { type: 'string', description: 'gate: the command run and its outcome, or why the gate does not apply' },
      gates: { type: 'array', description: 'gate: several gates in one call; all are recorded or none', items: { type: 'object', properties: { gate: { type: 'string', enum: ['CODE', 'TEST', 'TYPE', 'BUILD', 'SECURITY', 'GIT'] }, state: { type: 'string', enum: ['pass', 'fail', 'na', 'pending'] }, evidence: { type: 'string' } }, required: ['gate', 'state'] } },
      note: { type: 'string', description: 'why a milestone failed or is blocked, or a remark on its completion' },
      level: { type: 'string', enum: ['STANDARD', 'DEEP'], description: 'discover: raise the discovery level (never lowers it)' },
      criteria: { type: 'array', items: { type: 'string' }, description: 'discover: acceptance criteria, each a checkable sentence (at least two words); required before ALIGNED for STANDARD and DEEP work' },
      unknowns: { type: 'array', description: 'discover: material unknowns {id?, text, state open|resolved|assumed, note}', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, state: { type: 'string', enum: ['open', 'resolved', 'assumed'] }, note: { type: 'string' } } } },
      risks: { type: 'array', items: { type: 'string' }, description: 'discover: only the risk categories that apply' },
      decision: { type: 'object', description: 'decide: one consequential decision. An alternative needs the reason it was rejected; verified needs evidence', properties: { id: { type: 'string' }, problem: { type: 'string' }, chosen: { type: 'string' }, alternatives: { type: 'array', items: { type: 'object', properties: { option: { type: 'string' }, rejected_because: { type: 'string' } }, required: ['option', 'rejected_because'] } }, tradeoffs: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } }, status: { type: 'string', enum: ['provisional', 'verified', 'revised'] } }, required: ['problem', 'chosen'] },
      alignment: { type: 'object', description: 'align: the original-goal check. ALIGNED needs one demonstrated entry per criterion id from discover, with its evidence', properties: { state: { type: 'string', enum: ['ALIGNED', 'PARTIAL', 'BLOCKED', 'UNKNOWN'] }, demonstrated: { type: 'array', description: 'one entry per criterion id, each with its own observed evidence (a file, test name, command output or figure)', items: { type: 'object', properties: { id: { type: 'string', description: 'criterion id such as c1' }, status: { type: 'string', enum: ['met', 'failed', 'unresolved'] }, evidence: { type: 'string' } }, required: ['id', 'evidence'] } }, missing: { type: 'array', items: { type: 'string' } }, assumptions: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } }, required: ['state'] },
    },
    required: ['action'],
  },
} as const

const DISCIPLINE = `# Cobalt Cockpit

The user watches a HUD fed by the ${TOOL} tool. It shows real milestone progress and verification gates, never a guess.

For a substantial coding task (more than a trivial edit):
1. Inspect before editing, then call ${TOOL} with action "plan": 3-7 milestones in order, each with a phase (typically Inspect, Implement, Test, Fix, Verify).
2. Call "start" as you begin a milestone and "complete" only when it is really finished. Use "fail" or "block" with a note when it is not. Never complete a milestone to move the bar.
3. After implementing, run the relevant tests and checks, fix what fails, and verify the final state of the repository.
4. Report each verification gate with action "gate" (CODE, TEST, TYPE, BUILD, SECURITY, GIT; several in one call with "gates"): pass or fail with the command and its outcome as evidence, or na with the reason it does not apply. Test, type-check, build, lint and audit commands run through Bash are recorded automatically from their exit status; when that status is masked (output piped to another command, a background run) report the result yourself.
5. The task reads 100% and DONE only when every milestone is complete and every required gate is pass or na. If something cannot be verified, leave it UNVERIFIED and tell the user exactly what was not verified. If you are stuck, use "block" and state the blocker plainly. The end of a turn is not the end of the task.

For questions, explanations and other read-only work, skip the tool (or plan with kind "readonly") and do not run tests the work does not call for.`

const HYGIENE = `

Repository hygiene for this user:
- Never add AI attribution to repository work: no Co-authored-by line naming Claude, Anthropic, ChatGPT, Codex or any AI assistant, and no "Generated by AI", "Built with Claude" or similar, in commit messages, pull requests, code or docs.
- Do not create CLAUDE.md or AGENTS.md unless the user explicitly asks for one in that repository.`

const SAFETY = `

Destructive commands (hard reset, clean, force push, broad recursive deletes, database drops, production teardown) are shown to the user for confirmation before they run. If the user cancels one, do not retry it or reach the same effect another way; ask how to proceed.`

const HELP =
  '/cockpit            open or close Mission Control\n' +
  '/cockpit status     print the task state\n' +
  '/cockpit reset      clear the current task\n' +
  '/cockpit mute       silence the cues (kept across sessions); unmute to undo\n' +
  '/cockpit hud off    hide the HUD (kept across sessions); hud on to undo\n' +
  '/cockpit auth       print how the session is authenticated and the Fable policy\n' +
  '/cockpit version    print the loaded plugin version, its source path and the reasoning mode\n' +
  '/cockpit discovery  show the discovery level, unknowns, decisions and goal check; pin light | standard | deep, or auto\n' +
  '/cockpit router     show this session\'s router, or switch it: off, nobodywho, jev (this session only)\n' +
  '/cockpit stats     observed model use, routing and consultations: 7d | 30d | all, with --json or --csv\n' +
  '/cockpit flow      the Neural Flow in words: which of input, discovery, routing, workers, verify and done are verified\n' +
  '/cockpit guard     Cobalt Guard owner alerts: status; ack or silence (an alert never changes a verdict)\n' +
  '/cockpit doctor    read-only checks: installs, profile, telemetry storage, host and prompt-cache policy\n' +
  '/cockpit sound      play both cues'

const isAtLeast = (version: string, floor: readonly number[]): boolean => {
  const parts = version.split(/[.-]/).map(Number)
  for (let at = 0; at < floor.length; at++) {
    const have = parts[at] ?? 0
    const want = floor[at] ?? 0
    if (Number.isNaN(have)) return true
    if (have !== want) return have > want
  }

  return true
}

const healthLine = (): string => {
  const h = healthOf()

  return !h.enabled ? 'TELEMETRY / off (telemetry=false); nothing is being recorded.' : `TELEMETRY / this session wrote ${h.writes} record${h.writes === 1 ? '' : 's'}${h.failures > 0 ? `, ${h.failures} could not be written (incomplete coverage)` : ''} · files ${h.permissions === 'verified' ? 'read back as 0700 directory, 0600 files' : h.permissions === 'unverified' ? 'permissions could NOT be confirmed (the host gives plugins no file mode; the directory is only as private as your umask)' : 'not yet written'}`
}

const countPatch = (patch: unknown): { added: number; removed: number } => {
  let added = 0
  let removed = 0
  for (const hunk of Array.isArray(patch) ? patch : []) {
    const lines: unknown = (hunk as { lines?: unknown } | null)?.lines
    for (const line of Array.isArray(lines) ? lines : []) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }

  return { added, removed }
}

const isSameGit = (a: GitState | null, b: GitState): boolean =>
  a !== null &&
  a.isRepo === b.isRepo &&
  a.project === b.project &&
  a.branch === b.branch &&
  a.isDetached === b.isDetached &&
  a.sha === b.sha &&
  a.startSha === b.startSha &&
  a.dirty === b.dirty &&
  a.ahead === b.ahead &&
  a.behind === b.behind

const styleOf = (segment: Segment) => ({
  ...(segment.color !== undefined ? { color: segment.color } : {}),
  ...(segment.isDim === true ? { dimColor: true } : {}),
  ...(segment.isBold === true ? { bold: true } : {}),
})

type Config = {
  hasHud: boolean
  hasFlow: boolean
  isAnimated: boolean
  hasSounds: boolean
  hasGuard: boolean
  hasAttributionGuard: boolean
  volume: number
  /** Whether the optional NobodyWho ledger is read at all. */
  hasLocalControl: boolean
  /** An explicit ledger path, or '' to resolve one from the environment. */
  ledgerPath: string
  /** Whether the subagent limit, the Sonnet default and the reviewer's grounds are enforced. */
  blocksFable: boolean
  isStrict: boolean
  hasOrchestration: boolean
  /** The most subagents that run at once. */
  maxSubagents: number
  maxSonnet: number | 'AUTO'
  maxHaiku: number | 'AUTO'
  /** Whether a session on API-style authentication is refused its model requests. */
  isSubscriptionOnly: boolean
  /** AUTO chooses reasoning effort from the task; MANUAL honours the fixed tier levels. */
  reasoningMode: ReasoningMode
  /** Nothing above this level is ever requested; a higher ask falls back and is recorded. */
  maxEffort: EffortLevel
  /** Operator-declared effort capability per model id, overriding the built-in table. */
  modelEffort: Readonly<Record<string, readonly EffortLevel[]>>
  /** OPUS_LED (legacy): Opus commands. SONNET_LED: Sonnet builds and Opus is consulted on admission. */
  profile: Profile
  /**
   * A decision-router configuration directory the operator made for Cockpit's
   * JEV mode, or empty. It is handed to the router child process alone, and
   * only while the session's router is JEV; Cockpit never creates or edits it.
   */
  routerConfigDir: string
}

/** SONNET_LED is in force only where orchestration is enforced. */
const isSonnetLed = (): boolean => config.hasOrchestration && config.profile === 'SONNET_LED'

// The model each tier is requested on. The tier is the policy's; the model id is
// what the engine was asked for, and the capability table reads it.
const MODEL_FOR: Record<ModelTier, string> = { OPUS: MAIN_MODEL, SONNET: AGENT_MODEL, HAIKU: HAIKU_MODEL }

/**
 * The severity the effort policy may ask for, from the runtime observations the
 * session has really made, the operator's declared overrides, and the built-in
 * baseline. It is read-only over the facts and never assumes a level works.
 */
const capabilityOf = (model: string, known: Readonly<Record<string, readonly EffortLevel[]>>) =>
  capabilityFor(model, known, config.modelEffort)

// Set by register(); the rest is rebuilt as events arrive after a reload.
// Nothing a drawing depends on lives here: that is all in `$.state`.
let config: Config = { hasHud: true, hasFlow: true, isAnimated: true, hasSounds: true, hasGuard: true, hasAttributionGuard: true, volume: 0.6, hasLocalControl: true, ledgerPath: '', blocksFable: false, isStrict: false, hasOrchestration: false, maxSubagents: 16, maxSonnet: 'AUTO', maxHaiku: 'AUTO', isSubscriptionOnly: false, reasoningMode: 'AUTO', maxEffort: DEFAULT_CEILING, modelEffort: {}, profile: DEFAULT_PROFILE, routerConfigDir: '' }
let isSupported = true
/** True once the engine is known to take `effort` on an Agent call. */
let hasNativeEffort = false
/**
 * What each Agent call in flight was launched with, by its tool-use id: the
 * level set on the call, and the level the commander put there by hand, if
 * any. `agent.spawn` takes the entry and binds it to the task; the map is
 * bounded so a call that never spawns leaves nothing behind for long.
 */
const launches = new Map<string, { level: EffortLevel; named: EffortLevel | null }>()
const LAUNCHES_MAX = 64
/**
 * Who put the effort on each loop's request in flight, by agent id (`main` for
 * the main loop): set before the request is sent, because a tool of that very
 * response can report back before the request is recorded in the ledger.
 */
const sentVia = new Map<string, 'host' | 'hook'>()
/** The level the last `/effort` command of this session named, as typed; null when none was seen. */
let effortCommand: string | null = null
/** What was last seen of the main loop's effort sources, and the turn it was read in. */
let hostSignalsAt: { turnId: string; signals: HostEffortSignals } | null = null
let ticker: Timer | null = null
let gitTimer: Timer | null = null
type MountedBand = { requestId: string; width: number; input: HudInput; visual: Visual; agents: AgentStrip[]; glide: Glide; motion: boolean; lastCells: Map<string, string>; waiting: boolean; field: { tape: Tape; state: string; rows: number; width: number; graph: Graph | null } | null; flow: { input: FlowInput; width: number } | null }
let band: MountedBand | null = null
let head: { id: string; glide: Glide } | null = null
let isLight = false
let reducedMotion = false
let foldTimer: Timer | null = null
const agentSvgCache = new Map<string, { signature: string; source: string }>()
const svgCache = new Map<string, { signature: string; base: string; overlay: string }>()
let isTurnRunning = false
let cwd = ''
let home = ''

// The NobodyWho ledger watcher.
//
// Design constraints this satisfies, all of them load-bearing:
//   - read-only. Cockpit never writes, truncates or locks the ledger, and never
//     tells NobodyWho what to do; it only reads what the router already wrote.
//   - not aggressive. It polls on a slow timer and reads the file body only
//     when `$.fs.stat` says the size or mtime actually moved. A quiet ledger
//     costs one stat per tick and no read at all.
//   - self-limiting. It only ever looks for this session's own receipts, and it
//     gives up entirely once a read has failed twice in a row, so a broken or
//     hostile path cannot make the session do work forever.
//   - clean. `stopLedgerWatch` is idempotent and is called on session end and
//     before a reload re-primes, so no timer outlives the session.
//   - silent on failure. Every path returns without throwing; a ledger problem
//     must never touch the host.
let ledgerTimer: Timer | null = null
let ledgerCursor: Cursor | null = null
let ledgerPath: string | null = null
let ledgerMisses = 0

const LEDGER_POLL_MS = 1200
const LEDGER_MAX_BYTES = 512 * 1024
const LEDGER_GIVE_UP = 2

/** Where the router writes its receipts, or null when this machine has no home. */
const resolveLedger = async ($: EngineInterface): Promise<string | null> => {
  // An explicit setting wins, so a caller who keeps the ledger somewhere else
  // says so rather than the plugin guessing.
  if (config.ledgerPath !== '') return config.ledgerPath
  // `XDG_STATE_HOME` is authoritative when set, and `HOME` is the documented
  // fallback. Each is read behind its own guard, because a host that does not
  // expose `$.env` is a host where this integration simply stays off, which is
  // the correct outcome rather than a failure. The names are spelled out
  // literally because that is what lets the host list what the module reads.
  const state = await $.env.get('XDG_STATE_HOME').catch(() => undefined)
  if (state !== undefined && state !== '') return `${state}/decision-router/ledger.jsonl`
  const home = await $.env.get('HOME').catch(() => undefined)

  return home === undefined || home === '' ? null : `${home}/.local/state/decision-router/ledger.jsonl`
}

const stopLedgerWatch = () => {
  ledgerTimer?.cancel()
  ledgerTimer = null
}

/**
 * Reads the ledger once and folds in whatever is genuinely new.
 *
 * The first read primes the cursor at the end of the file and emits nothing,
 * which is what stops a session from flashing a year of history on startup and
 * what makes a hot reload resume instead of replay.
 */
const utf8Bytes = (text: string): number => [...text].reduce((n, ch) => { const cp = ch.codePointAt(0)!; return n + (cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4) }, 0)
const sliceBytes = (text: string, offset: number): string => { let at = 0, index = 0; for (const ch of text) { if (at >= offset) break; at += utf8Bytes(ch); index += ch.length } return text.slice(index) }

const pollLedger = async ($: EngineInterface): Promise<void> => {
  const path = ledgerPath
  if (path === null) return
  let size = -1
  try {
    const stat = await $.fs.stat(path)
    size = stat.size
  } catch {
    // No ledger, or no permission: this is normal, not an error.
    if (++ledgerMisses >= LEDGER_GIVE_UP) stopLedgerWatch()

    return
  }
  const cursor = ledgerCursor ?? await read($, cursorAtom) ?? cursorAt(size)
  if (cursor.primed && size === cursor.size) return
  // A file that shrank was rotated or replaced: resume at its end rather than
  // slicing a stale offset into different content.
  const rotated = size < cursor.size
  const from = rotated ? cursorAt(size) : cursor
  let text = ''
  try {
    // Only the tail is read, and only a bounded slice of it, so a large ledger
    // is never copied into the session in full.
    if (size > LEDGER_MAX_BYTES) {
      const tail = await $.process.run(['tail', '-c', String(LEDGER_MAX_BYTES), '--', path], { timeoutMs: 2000 })
      if (tail.exitCode !== 0 || tail.isStdoutTruncated) throw new Error('ledger tail unavailable')
      // Locate the old cursor by bytes within the bounded UTF-8 tail.
      const bytes = utf8Bytes(tail.stdout)
      const start = size - bytes
      const offset = Math.max(0, from.offset - start)
      text = sliceBytes(tail.stdout, offset)
      if (from.offset < start) text = text.slice(text.indexOf('\n') + 1)
    } else {
      const whole = await $.fs.read(path)
      text = sliceBytes(whole, from.offset)
    }
  } catch {
    if (++ledgerMisses >= LEDGER_GIVE_UP) stopLedgerWatch()

    return
  }
  ledgerMisses = 0
  // `drain` works on the tail it is handed, so its cursor offset is relative to
  // that tail; the absolute position stays here in `ledgerCursor`.
  const tail = { ...from, offset: 0 }
  const drained = drain(text, tail, 'claude')
  const remainingBytes = utf8Bytes(text.slice(drained.cursor.offset))
  ledgerCursor = { ...drained.cursor, offset: size - remainingBytes, size }
  await update($, cursorAtom, () => ledgerCursor)
  if (drained.events.length === 0) return
  const fresh = (await read($, ledgerAtom)).receipts
  await mutateLedger($, l => receipts(l, drained.events))
  for (const x of drained.events) if (!fresh.some(old => old.requestId === x.requestId)) await tele($, { k: 'nwho', op: x.op, tier: String(x.tier).toLowerCase(), ms: typeof x.latencyMs === 'number' ? x.latencyMs : null })
  // Only now, with real events in hand, does the session's telemetry change.
  const seen = await $.clock.now()
  await update($, controlAtom, old => fold(old, drained.events, seen))
  const newest = drained.events[drained.events.length - 1]
  if (newest === undefined) return
  await update($, flashAtom, () => ({ text: stripText(newest), op: newest.op, at: seen }))
}

/** Starts the watcher once, after the ledger's location is known. */
const startLedgerWatch = async ($: EngineInterface): Promise<void> => {
  if (ledgerTimer !== null || !config.hasLocalControl) return
  ledgerPath = await resolveLedger($)
  // No resolvable ledger means this machine does not run the router, so there is
  // nothing to watch and no timer is ever created.
  if (ledgerPath === null) return
  await quiet(async () => pollLedger($))
  ledgerTimer = $.clock.every(LEDGER_POLL_MS, () => quiet(async () => pollLedger($)))
}
let lastEffort: string | null = null
/** The player that worked; null once none did, so a silent machine is asked once. */
let player: Player | null | undefined
/**
 * Where the field's crawler currently stands. Module state, like the ticker: it
 * is animation rather than fact, so it is rebuilt from the real tape on every
 * draw and a hot reload simply restarts the walk where the tape now says.
 */
let fieldWalker: Walker = RESTING

/** Runs bookkeeping that must never fail the event it rides on. */
// --- Prompt-cache policy (cache.ts): read, never written. ---
let cacheReading: CacheReading | null = null
let seenPermissionMode: string | null = null
const otherCockpits: { root: string; provenance: string }[] = []
const cacheFacts = async ($: EngineInterface): Promise<CacheReading> => {
  const version = await $.session.version().catch(() => null)
  // only the one setting is taken from the merged settings; nothing else in them is read, kept or shown
  const settings = await $.settings.read().catch(() => ({} as Record<string, unknown>))

  return readCache({
    version: version === null ? null : (version.base ?? version.version),
    forceFiveMinute: await $.env.get('FORCE_PROMPT_CACHING_5M').catch(() => undefined),
    envTtl: await $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL').catch(() => undefined),
    settingTtl: settings['subagentPromptCacheTtl'],
    enableOneHour: await $.env.get('ENABLE_PROMPT_CACHING_1H').catch(() => undefined),
  })
}
const flowTierOf = (model: string | null | undefined): FlowTier | null => { const t = modelTier(model); return t === 'OTHER' ? null : t }
const flowInputOf = (input: HudInput, agents: readonly AgentStrip[], isWorking: boolean): FlowInput => ({
  task: input.task,
  // the same two witnesses as the HUD's own state: the engine says a turn runs and Cockpit saw the activity
  isWorking: isWorking && input.activity.isWorking,
  agents: agents.map(a => ({ tier: flowTierOf(a.model), running: a.state === 'running' })),
  mainTier: flowTierOf(input.meter.model),
})
const stopFacts = async ($: EngineInterface): Promise<StopFacts> => {
  const c = await loadStopCfg($)
  const last = ((await read($, ledgerAtom)).stopChecks ?? []).at(-1)

  return {
    policy: c.policy, script: c.script === null ? null : c.script.slice(c.script.lastIndexOf('/') + 1), pinned: c.pin !== null,
    timeoutSec: Math.round(c.timeoutMs / 1000), maxAttempts: c.maxAttempts, problems: c.problems, trust: c.script === null ? 'no script' : TRUST_WORDS[(await trustState($, c)).state],
    last: last === undefined ? null : { outcome: last.outcome, exit: last.exit, at: last.at },
  }
}

const doctorFacts = async ($: EngineInterface): Promise<DoctorFacts> => {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? null
  const version = await $.session.version().catch(() => null)
  const host = version === null ? null : (version.base ?? version.version)
  let manifestVersion: string = UNKNOWN
  try { manifestVersion = /"version"\s*:\s*"([^"]+)"/.exec(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))?.[1] ?? UNKNOWN } catch { /* unreadable */ }
  // the install record lists plugin installs; only the cobalt-cockpit entries are taken from it
  let installs: Install[] | null = null
  try {
    const dir = (await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)) ?? (home === null ? null : `${home}/.claude`)
    if (dir !== null) {
      const record = JSON.parse(await $.fs.read(`${dir}/plugins/installed_plugins.json`)) as { plugins?: Record<string, unknown> }
      installs = Object.entries(record.plugins ?? {}).filter(([key]) => key.startsWith('cobalt-cockpit@')).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((v): Install => {
        const r = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>

        return { key, version: typeof r['version'] === 'string' ? r['version'] : null, path: typeof r['installPath'] === 'string' ? r['installPath'] : null }
      }))
    }
  } catch { installs = null }
  let enabled: string[] | null = null
  try {
    const settings = await $.settings.read()
    const plugins = (typeof settings['enabledPlugins'] === 'object' && settings['enabledPlugins'] !== null ? settings['enabledPlugins'] : {}) as Record<string, unknown>
    enabled = Object.entries(plugins).filter(([key, on]) => key.startsWith('cobalt-cockpit@') && on === true).map(([key]) => key)
  } catch { enabled = null }
  let listed: { files: number; bytes: number } | null = null
  const dir = await telemetryDir($)
  if (dir !== null) {
    try {
      const files = (await $.fs.list(dir)).filter(x => x.kind === 'file' && isTelemetryFile(x.name))
      listed = { files: files.length, bytes: files.reduce((n, x) => n + x.size, 0) }
    } catch { listed = null }
  }
  const ledger = await read($, ledgerAtom)
  const h = healthOf()

  return {
    version: manifestVersion, root: $.plugin.root, home, host, hostSupported: host === null ? null : isSupported,
    profile: config.profile, orchestration: config.hasOrchestration, reasoning: config.reasoningMode, router: (await read($, routerAtom)).mode,
    permissionMode: seenPermissionMode, installs, enabled, otherRegistrations: [...otherCockpits],
    telemetry: { enabled: h.enabled, dir, listed, writes: h.writes, failures: h.failures, permissions: h.permissions, shed: h.shed },
    cache: await cacheFacts($),
    agents: agentsOf(ledger.agents.map(a => (typeof a.start === 'number' && typeof a.end === 'number' ? a.end - a.start : null))),
    stop: await stopFacts($),
    guard: await (async () => { const v = await guardView($); return { enabled: guardCfg.enabled, label: guardLabel(guardCfg, v.state, v.kept), used: v.state.count, max: guardCfg.maxPerSession, cooldownSec: Math.round(guardCfg.cooldownMs / 1000) } })(),
  }
}

// --- Local telemetry (what is kept and how: telemetry.ts). The host follows `$` only into functions declared in this file. ---
const telemetryDir = async ($: EngineInterface): Promise<string | null> =>
  dirFor(await $.env.get('XDG_STATE_HOME').catch(() => undefined), await $.env.get('HOME').catch(() => undefined))

/** Reads a mode back with stat, so "restricted" is only ever said of a mode that was seen. A refusal or an error is "unverified"; nothing else is tried. */
const modeIs = async ($: EngineInterface, path: string, mode: string): Promise<boolean> => {
  try {
    const r = await $.process.run(['stat', '-c', '%a', path], { timeoutMs: 5000 })

    return r.exitCode === 0 && r.stdout.trim() === mode
  } catch { return false }
}

const restrictTelemetry = async ($: EngineInterface, dir: string): Promise<void> => {
  // the host's write has no mode argument, so the directories are asked to be 0700 first and each file 0600 once it exists
  let ok = true
  for (const d of [dir.slice(0, dir.lastIndexOf('/')), dir]) {
    try { ok = (await $.process.run(['mkdir', '-p', '-m', '700', d], { timeoutMs: 5000 })).exitCode === 0 && ok } catch { ok = false }
  }
  // mkdir -m leaves an existing directory as it was, so the mode is read back rather than assumed
  health.permissions = ok && await modeIs($, dir, '700') ? 'verified' : 'unverified'
}

const pruneTelemetry = async ($: EngineInterface, dir: string, now: number): Promise<void> => {
  try {
    const listed = (await $.fs.list(dir)).filter(x => x.kind === 'file' && !x.isLink && isTelemetryFile(x.name))
    // exact telemetry file names only, inside our own directory; a refusal is final and is not worked around
    const doomed = new Set([...expiredFiles(listed.map(x => x.name), now), ...shedFiles(listed.filter(x => !expiredFiles([x.name], now).length), TOTAL_CAP_BYTES, new Set())])
    for (const name of doomed) {
      const r = await $.process.run(['rm', '-f', '--', `${dir}/${name}`], { timeoutMs: 5000 })
      if (r.exitCode === 0) health.shed++
    }
  } catch { /* retention is best effort */ }
}

/** Records one observed event. Never throws; writes are taken one at a time, and only this process's own segment is ever written. */
const tele = ($: EngineInterface, event: Record<string, unknown>): Promise<void> => {
  if (!health.enabled) return Promise.resolve()
  teleQueue.tail = teleQueue.tail.then(async () => {
    try {
      const dir = await telemetryDir($)
      if (dir === null) { health.failures++; return }
      const at = await $.clock.now()
      const e = cleanEvent({ v: 1, t: at, ...event })
      if (e === null) { health.failures++; return }
      health.dir = dir
      if (prepared.dir !== dir) {
        prepared.dir = dir
        // a smaller segment may be asked for (never a larger one); it exists so the sealing can be exercised without writing 64 KiB
        const asked = Number(await $.env.get('COBALT_TELEMETRY_SEGMENT_BYTES').catch(() => undefined))
        if (Number.isInteger(asked) && asked >= 512 && asked < limits.segmentCap) limits.segmentCap = asked
        await restrictTelemetry($, dir); await pruneTelemetry($, dir, at)
      }
      const line = encode(e)
      const month = monthKey(at)
      segment.sid ??= newSid(at)
      // a full segment is sealed and never written again; a new month starts a new one
      if (segment.month !== month || segment.bytes + line.length + 1 > limits.segmentCap) { segment.n = segment.month === null ? 0 : segment.n + 1; segment.month = month; segment.lines = []; segment.bytes = 0 }
      segment.lines.push(line); segment.bytes += line.length + 1
      const path = `${dir}/${segmentName(month, segment.sid, segment.n)}`
      // this process is the only writer of this file, so the whole segment is rewritten from memory with nothing read back
      await $.fs.write(path, `${segment.lines.join('\n')}\n`)
      if (!segment.verified.has(path)) {
        segment.verified.add(path)
        let ok = false
        try { ok = (await $.process.run(['chmod', '600', path], { timeoutMs: 5000 })).exitCode === 0 } catch { ok = false }
        if (!ok || !(await modeIs($, path, '600'))) health.permissions = 'unverified'
      }
      health.writes++
    } catch { health.failures++ }
  })

  return teleQueue.tail
}

/** Reads the events of a window. Unreadable files and damaged lines are counted, not thrown. */
const readStats = async ($: EngineInterface, win: { label: string; days: number | null }) => {
  const now = await $.clock.now()
  const dir = await telemetryDir($)
  const texts: (string | null)[] = []
  if (dir !== null) {
    let names: string[] = []
    try { names = (await $.fs.list(dir)).filter(x => x.kind === 'file' && !x.isLink).map(x => x.name) } catch { /* no directory yet */ }
    for (const name of filesFor(names, now, win)) texts.push(await $.fs.read(`${dir}/${name}`).catch(() => null))
  }

  return gather(texts, now, win)
}

const quiet = async (work: () => unknown): Promise<void> => {
  try {
    await work()
  } catch {
    // the HUD goes stale rather than the session breaking
  }
}

/**
 * A reading whose failure must not fail the event it rides on, for the one case
 * `quiet` cannot serve: a hook that fails *before* `next` is skipped by the
 * engine, so a hook that decides must reach its decision even when a reading
 * beneath it does not answer.
 */
const quietly = async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await work()
  } catch {
    return undefined
  }
}

const stopTicker = () => {
  ticker?.cancel()
  ticker = null
}

/** Whether anything on the band is genuinely animating right now. */
const bandBusy = (mounted: MountedBand): boolean =>
  mounted.visual.active || mounted.agents.some(a => a.state === 'running') || mounted.field !== null || (mounted.flow !== null && flowOf(mounted.flow.input).live)

const startTicker = ($: EngineInterface) => {
  if (!config.isAnimated || reducedMotion || ticker !== null || band === null || !band.motion) return
  if (!bandBusy(band)) return
  ticker = $.clock.every(FRAME_MS, async () => {
    const mounted = band
    if (!mounted || !mounted.motion || !bandBusy(mounted)) {
      stopTicker()
      return
    }
    const now = await $.clock.now()
    const blit = async (key: string, cells: string, rows = 1, columns = mounted.width) => {
      if (mounted.lastCells.get(key) === cells) return
      mounted.lastCells.set(key, cells)
      const result = await $.ui.blit({ requestId: mounted.requestId, key, cells, columns, rows }).catch(() => ({ deny: 'unmounted' }))
      if (result.deny && band === mounted) { band = null; stopTicker() }
    }
    if (mounted.visual.active) {
      // The track is redrawn whole each frame because the crawler rides it: the
      // per-key cell diff still suppresses the blit whenever the result is
      // byte-identical, so a still crawler costs nothing.
      const grid = trackGrid(mounted.input, mounted.visual, mounted.width, { head: positionAt(mounted.glide, now), now, motion: true, light: isLight })
      const input = await crawlerOf($, mounted.input, mounted.visual, mounted.waiting)
      if (crawlerForm(mounted.width) === 'body') paintCrawler(grid, { ...input.crawler, progress: positionAt(mounted.glide, now) }, { now, reducedMotion: false }, layerFor(input.crawler, input.newest))
      await blit(TRACK_KEY, grid.encode())
    }
    // No full-tree redraws for clocks: only the strips whose cells changed.
    for (const a of mounted.agents) if (a.state === 'running') await blit(`agent-${a.id}`, stripGrid(a, mounted.width, now, isLight, true).encode())
    // The Activity Field: the crawler takes one step per frame and the whole
    // field is repainted, because the creature moves through the tape rather
    // than sitting on it. The per-key diff still suppresses the blit whenever a
    // frame is byte-identical, so a settled crawler costs nothing at all.
    // The Neural Flow: the marker moves only while the flow's input says work is live; the per-key diff drops identical frames.
    if (mounted.flow !== null) {
      const f = flowOf(mounted.flow.input)
      const grid = f.live ? flowGrid(f, mounted.flow.width, { now, motion: true, light: isLight }) : null
      if (grid !== null) await blit(FLOW_KEY, grid.encode(), 1, mounted.flow.width)
    }
    if (mounted.field !== null && mounted.field.tape.anchors.length > 0) {
      fieldWalker = advance(fieldWalker, mounted.field.tape, mounted.field.state, { now, reducedMotion: false })
      await blit(FIELD_KEY, fieldGrid(mounted.field.tape, fieldWalker, mounted.field.state, mounted.field.width, mounted.field.rows).encode(), mounted.field.rows, mounted.field.width)
    }
  })
}

const editAgent = async ($: EngineInterface, id: string, edit: (a: AgentStrip) => AgentStrip) => {
  await update($, visualAtom, old => ({ ...old, agents: old.agents.map(a => a.id === id ? edit(a) : a) }))
}
const scheduleFold = async ($: EngineInterface) => {
  foldTimer?.cancel()
  foldTimer = null
  const now = await $.clock.now()
  const agents = (await read($, visualAtom)).agents
  const due = agents.filter(a => a.state === 'done' && a.endedAt !== null && a.endedAt + FOLD_MS > now).map(a => a.endedAt! + FOLD_MS)
  if (!due.length) return
  foldTimer = $.clock.after(Math.min(...due) - now, async () => {
    foldTimer = null
    await update($, visualAtom, old => ({ ...old, revision: old.revision + 1 }))
    await scheduleFold($)
  })
}

// Spawns in flight: `agent.spawn` hooks that have not returned yet, each with
// the id of the agent it started once the engine has answered. Several Agent
// calls of one message reach the hook together, so each counts the ones ahead of
// it that the engine's own list does not show yet, and none is counted twice.
const spawning = new Map<symbol, string | null>()
/** The settings name Fable as the advisor: read with the auth probe, and enough to refuse every request. */
let isAdvisorFable = false
let hasAdvisor = false
const AUTH_TOAST_MS = 8000

/** Counts one refusal and leaves its one line. Nothing about the request is kept. */
const recordBlock = async ($: EngineInterface): Promise<void> => {
  await quiet(async () => {
    const now = await $.clock.now()
    await update($, policyAtom, old => blocked(old, now))
  })
  await quiet(() => $.ui.log(BLOCK_LINE))
}

/**
 * Reads how the session is authenticated, without ever holding a secret
 * longer than it takes to see that one is there.
 *
 * The engine answers the kind of its own credential; each API-style variable
 * is asked for by its literal name and reduced to present or absent on the
 * spot; the settings are read for a key helper, the same variables and an
 * advisor. Only names from `auth.ts`'s fixed table reach the state.
 */
const probeAuth = async ($: EngineInterface, announce: boolean): Promise<void> => {
  const present: string[] = []
  const isSet = (value: string | undefined): boolean => value !== undefined && value !== ''
  if (isSet(await $.env.get('ANTHROPIC_API_KEY').catch(() => undefined))) present.push('env ANTHROPIC_API_KEY')
  if (isSet(await $.env.get('ANTHROPIC_AUTH_TOKEN').catch(() => undefined))) present.push('env ANTHROPIC_AUTH_TOKEN')
  if (isSet(await $.env.get('ANTHROPIC_BASE_URL').catch(() => undefined))) present.push('env ANTHROPIC_BASE_URL')
  if (isSet(await $.env.get('ANTHROPIC_CUSTOM_HEADERS').catch(() => undefined))) present.push('env ANTHROPIC_CUSTOM_HEADERS')
  if (isSet(await $.env.get('CLAUDE_CODE_USE_BEDROCK').catch(() => undefined))) present.push('env CLAUDE_CODE_USE_BEDROCK')
  if (isSet(await $.env.get('CLAUDE_CODE_USE_VERTEX').catch(() => undefined))) present.push('env CLAUDE_CODE_USE_VERTEX')
  if (isSet(await $.env.get('CLAUDE_CODE_USE_FOUNDRY').catch(() => undefined))) present.push('env CLAUDE_CODE_USE_FOUNDRY')
  if (isSet(await $.env.get('CLAUDE_CODE_USE_MANTLE').catch(() => undefined))) present.push('env CLAUDE_CODE_USE_MANTLE')
  let credential: Credential = 'unknown'
  try {
    const held = await $.session.authorize()
    // the handle is dropped here: only the kind is of interest
    credential = held === null ? 'none' : held.kind
  } catch {
    // an engine that does not answer leaves the reading UNVERIFIED
  }
  try {
    const settings = await $.settings.read()
    present.push(...settingsSources(settings))
    isAdvisorFable = fableConfigured(settings)
    hasAdvisor = typeof settings['advisorModel'] === 'string' && settings['advisorModel'] !== ''
  } catch {
    // no settings to read: nothing is claimed about them
  }
  const fresh = authOf(credential, present, await $.clock.now())
  const old = await read($, authAtom)
  const isSame = old !== null && old.mode === fresh.mode && old.credential === fresh.credential && old.sources.join() === fresh.sources.join()
  if (isSame) return
  await update($, authAtom, () => fresh)
  if (!announce) return
  // The startup diagnostic: a few seconds over the transcript, then gone, so
  // nothing about Fable holds a row of the HUD.
  await quiet(() => $.ui.toast(authLines(fresh, config.blocksFable).join(' · '), { timeoutMs: AUTH_TOAST_MS }))
  if (fresh.mode === 'api') {
    await quiet(() =>
      $.ui.log(
        `AUTH / API DETECTED (${[...(fresh.credential === 'api-key' ? ['engine holds an API key'] : []), ...fresh.sources].join(', ')}). ${
          config.isSubscriptionOnly ? 'Cockpit sends no model request on API-style authentication.' : 'The subscriptionOnly option is off, so requests are allowed.'
        }`,
      ),
    )
  }
}

/** Whether the session's requests are refused because it is not on the subscription. */
const isApiRefused = async ($: EngineInterface): Promise<boolean> => {
  if (!config.isSubscriptionOnly) return false

  return (await read($, authAtom).catch(() => null))?.mode === 'api'
}

/**
 * The ids of the subagents running now: the engine's own list where it
 * answers, and the strips this plugin drew from real spawns where it does not.
 */
const runningAgents = async ($: EngineInterface): Promise<Set<string>> => {
  try {
    return new Set((await $.agent.list()).filter(one => one.status === 'running' && one.type !== 'teammate').map(one => one.id))
  } catch {
    return new Set((await read($, visualAtom)).agents.filter(a => a.endedAt === null).map(a => a.id))
  }
}

/** What the failure streak is keyed on: the gates a check settles, or the tool and program that ran. */
const outcomeKey = (tool: string, input: Record<string, unknown>, gates: readonly string[]): string => {
  if (gates.length > 0) return gates.join('+')
  if (tool !== 'Bash') {
    // the same tool on the same file: a second missing file is a different failure
    const target = basename(String(input['file_path'] ?? input['notebook_path'] ?? '')).replace(/[^\w.-]/g, '').slice(0, 40)

    return target === '' ? tool : `${tool} ${target}`
  }
  const program = basename(String(input['command'] ?? '').trim().split(/\s+/)[0] ?? '').replace(/[^\w.-]/g, '').slice(0, 24)

  return program === '' ? 'Bash' : `Bash ${program}`
}

/**
 * The one-time note for a failure that has repeated, or null.
 *
 * This is the whole of the "repeated error" path: a counter, the local
 * router's latest decision if a real receipt arrived since the streak began,
 * and one sentence. No model is called to decide it.
 */
const repeatedErrorHint = async ($: EngineInterface): Promise<string | null> => {
  if (!config.hasOrchestration) return null
  const o = await read($, orchestraAtom)
  const decision = (await read($, controlAtom)).lastDecision
  const route = decision !== null && o.streakAt !== null && decision.at >= o.streakAt ? decision.route : null
  const hint = reviewHint(o, route)
  if (hint !== null) await update($, orchestraAtom, old => ({ ...old, hinted: true }))

  return hint
}

/** Refuses `/model fable` and `/advisor fable` before the engine changes anything. */
const guardModelCommand = async ($: EngineInterface, args: string): Promise<{ text: string } | null> => {
  if (!config.blocksFable) return null
  if (!args.split(/[\s=,]+/).some(isFable)) return null
  await recordBlock($)

  return { text: `${BLOCK_LINE}. Nothing was changed.` }
}

const attempt = async ($: EngineInterface, candidate: Player, file: string): Promise<boolean> => {
  try {
    const ran = await $.process.run(candidate.argv(file, config.volume), { timeoutMs: PLAY_TIMEOUT_MS })

    return ran.exitCode === 0
  } catch {
    // not installed, or still running at the timeout: the next one is tried
    return false
  }
}

/**
 * Plays a cue with the first player this machine answers to, PipeWire's
 * first, the terminal bell last; resolves with its name, or null for silence.
 * It never throws and never writes to the transcript.
 */
const sound = async ($: EngineInterface, cue: Cue): Promise<string | null> => {
  try {
    if (!config.hasSounds || (await read($, prefsAtom)).isMuted) return null
    const file = `${$.plugin.root}/${ASSETS[cue]}`
    if (player === null) return null
    if (player !== undefined) return (await attempt($, player, file)) ? player.name : null
    for (const candidate of PLAYERS) {
      if (await attempt($, candidate, file)) {
        player = candidate
        $.ui.log(`cues play through ${candidate.name}`, { to: 'debug' })

        return candidate.name
      }
    }
    player = null
    $.ui.log('no audio player answered; cues are silent', { to: 'debug' })

    return null
  } catch {
    return null
  }
}

/** Applies a change to the task, settles what follows from it, and plays what it earned. */
const change = async ($: EngineInterface, apply: (task: Task, now: number) => Task): Promise<Task | null> => {
  const now = await $.clock.now()
  let cues: Cue[] = []
  const task = await update($, taskAtom, old => {
    cues = []
    if (old === null) return old
    const settled = settle(apply(old, now))
    cues = settled.cues

    return settled.task
  })
  for (const cue of cues) void sound($, cue)

  return task
}

const refreshGit = async ($: EngineInterface): Promise<void> => {
  try {
    const now = await $.clock.now()
    cwd = await $.session.cwd()
    const status = await $.process.run(['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'], {
      timeoutMs: GIT_TIMEOUT_MS,
    })
    const old = await read($, gitAtom)
    let state: GitState
    if (status.exitCode !== 0) {
      state = {
        isRepo: false,
        project: projectOf(cwd),
        branch: null,
        isDetached: false,
        sha: null,
        startSha: null,
        dirty: 0,
        ahead: null,
        behind: null,
        at: now,
      }
    } else {
      const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: GIT_TIMEOUT_MS })
      const project = projectOf(top.exitCode === 0 && top.stdout.trim() !== '' ? top.stdout.trim() : cwd)
      const parsed = parseStatus(status.stdout)
      const isSameRepo = old !== null && old.isRepo && old.project === project
      state = {
        isRepo: true,
        project,
        ...parsed,
        startSha: isSameRepo ? (old.startSha ?? parsed.sha) : parsed.sha,
        at: now,
      }
    }
    if (!isSameGit(old, state)) await update($, gitAtom, () => state)
  } catch {
    // git missing or slow: the HUD keeps what it had
  }
}

const scheduleGit = ($: EngineInterface) => {
  if (gitTimer !== null) return
  gitTimer = $.clock.after(GIT_DEBOUNCE_MS, () => {
    gitTimer = null
    void refreshGit($)
  })
}

const setMeter = async ($: EngineInterface, patch: Partial<Meter>): Promise<void> => {
  const old = await read($, meterAtom)
  const merged = { ...old, ...patch }
  const isSame = (Object.keys(merged) as (keyof Meter)[]).every(key => merged[key] === old[key])
  if (!isSame) await update($, meterAtom, current => ({ ...current, ...patch }))
}

const refreshMeter = async ($: EngineInterface): Promise<void> => {
  try {
    const usage = await $.session.usage()
    const selectedModel = await $.session.model()
    const ledger = await read($, ledgerAtom)
    const actualModel = ledger.runs.find(r => r.id === ledger.currentRun)?.model
    const model = actualModel && actualModel !== UNKNOWN ? actualModel : selectedModel
    await setMeter($, {
      percent: usage.context.percent ?? null,
      tokens: usage.context.tokens ?? null,
      window: usage.context.window,
      model,
    })
  } catch {
    // no reading yet
  }
}

const routerPolicy = (): RouterPolicy => ({ profile: config.profile, hasOrchestration: config.hasOrchestration, hasHaiku: config.maxHaiku !== 0, hasSonnet: config.maxSonnet !== 0 })

let routerDirSeen: { option: string; cwd: string; dir: string | null; refused: string | null } | null = null

/**
 * The operator's router configuration directory for JEV mode, resolved, or why
 * it is not used. It must be the operator's own: a directory inside the project
 * is refused, because a repository must never be able to choose where the
 * router sends a request or which key it presents. Cockpit only names the
 * directory to the router's child process; it does not read or write it.
 */
const routerDir = async ($: EngineInterface): Promise<{ dir: string | null; refused: string | null }> => {
  const option = config.routerConfigDir
  if (option === '') return { dir: null, refused: null }
  if (routerDirSeen !== null && routerDirSeen.option === option && routerDirSeen.cwd === cwd) return routerDirSeen
  const judged = await (async (): Promise<{ dir: string | null; refused: string | null }> => {
    let path = option
    if (option.startsWith('~/')) {
      const home = await $.env.get('HOME').catch(() => undefined)
      if (home === undefined || !home.startsWith('/')) return { dir: null, refused: 'HOME is not set, so ~ could not be resolved' }
      path = `${home.replace(/\/+$/, '')}${option.slice(1)}`
    }
    const real = await canonicalResource($, path)
    const root = await canonicalResource($, cwd || '.')
    if (real === '*' || real === '/') return { dir: null, refused: 'it could not be resolved to a directory' }
    if (root === '*') return { dir: null, refused: 'the project root could not be resolved, so it could not be told apart from the project' }
    if (real === root || real.startsWith(`${root}/`) || root.startsWith(`${real}/`)) return { dir: null, refused: 'it is inside this project (or contains it); a router configuration must be your own, outside any repository' }

    return { dir: real, refused: null }
  })()
  routerDirSeen = { option, cwd, ...judged }

  return judged
}

/** The environment of a router child: nothing, except the operator's directory in JEV mode. */
const routerEnv = async ($: EngineInterface, mode: ActiveMode): Promise<Record<string, string> | undefined> => {
  if (mode !== 'JEV') return undefined
  const { dir } = await routerDir($)

  return dir === null ? undefined : { DECISION_ROUTER_CONFIG_DIR: dir }
}

/**
 * Runs the router's own CLI once per body, at the same time, and reads each
 * answer. This is the only place a router process starts, and it starts only
 * for a mode the person selected. Every request is started before the first
 * await, so nothing can come between the caller's last check and the start.
 * No credential enters this process: the router reads its own key.
 */
const askRouter = ($: EngineInterface, mode: ActiveMode, bodies: readonly string[], env: Record<string, string> | undefined): Promise<(RouterAnswer | null)[]> =>
  Promise.all(bodies.map(async body => {
    try {
      const r = await $.process.run(routerArgv(mode, body), { timeoutMs: CALL_TIMEOUT_MS[mode], ...(env === undefined ? {} : { env }) })

      return r.exitCode === 0 && !r.isStdoutTruncated ? answerOf(r.stdout) : null
    } catch { return null }
  }))

/**
 * The router's reading of a new task, when one is selected and the rules have
 * not already settled the route. Returns the one advisory line an accepted
 * recommendation adds to the task, or null. Whatever happened is recorded as
 * it happened; a reading begun before a switch is dropped, not used.
 */
const routeTask = async ($: EngineInterface, text: string, facts: Parameters<typeof deterministicRoute>[0]): Promise<string | null> => {
  const held = await read($, routerAtom)
  // what happened at the start of this task is told to telemetry as it was: no router, or the rules settling it, or a router asked
  if (held.mode === 'OFF') { await tele($, { k: 'route', mode: 'OFF', path: 'off', calls: 0, answered: 0, outcome: 'none', provider: null, ms: null }); return null }
  const mode = held.mode
  // Decided more cheaply by rule: a mandatory consultation, or a route the rules read off the task.
  const rules = deterministicRoute(facts)
  if (mandatoryGrounds(facts).length > 0 || rules.route !== 'direct') { await tele($, { k: 'route', mode, path: 'rules', calls: 0, answered: 0, outcome: 'none', provider: null, ms: null }); return null }
  const state = routerStateOf(text, mode)
  const calls = state === null ? [] : callsFor(state)
  if (state === null && !carriesCredential(text)) return null
  const env = calls.length === 0 ? undefined : await routerEnv($, mode)
  const started = await $.clock.now()
  // the last look before anything is sent: a switch made meanwhile sends nothing
  if ((await read($, routerAtom)).epoch !== held.epoch) return null
  const answers = calls.length === 0 ? [] : await askRouter($, mode, calls.map(c => c.body), env)
  const at = await $.clock.now()
  const reading = calls.length === 0 ? { route: null, features: {}, agreed: 0, invalid: 'prompt withheld: credential-shaped text is never shown to a router' } : readAnswers(mode, calls, answers)
  const verdict = reading.route === null ? null : adjudicate(reading.route, facts, routerPolicy())
  const decision = decisionOf({ at, mode, calls: calls.length, answers, wallMs: calls.length === 0 ? null : at - started, reading, rules: rules.route, verdict })
  if ((await read($, routerAtom)).epoch !== held.epoch) return null
  await update($, routerAtom, s => withDecision(s, held.epoch, decision))
  await mutateLedger($, l => ({ ...l, routing: addDecision(l.routing ?? [], decision) }))
  await tele($, { k: 'route', mode, path: calls.length > 0 ? 'router' : 'rules', calls: decision.calls, answered: decision.answered, outcome: decision.outcome, provider: decision.provider, ms: decision.wallMs })
  // An Opus reading the rules refuse goes to the person, never to the model.
  const notice = operatorNotice(mode, reading, verdict)
  if (notice !== null) await quiet(() => $.ui.toast(notice, { timeoutMs: 15_000 }))

  return decision.outcome === 'accepted' && reading.route !== null ? adviceLine(mode, reading.route) : null
}

/** Switches the session's router and, for a provider, checks once that it answers. Returns what to tell the person. */
const selectRouter = async ($: EngineInterface, mode: RouterMode): Promise<string> => {
  const switched = await update($, routerAtom, s => switchRouter(s, mode))
  if (mode === 'OFF') return 'ROUTER / OFF · deterministic policy only. No router is asked in this session.'
  // One fixed question that carries nothing of the session, so the mode's state is seen, not assumed.
  const probe = callsFor(AVAILABILITY_STATE)[0]!
  const dir = mode === 'JEV' ? await routerDir($) : { dir: null, refused: null }
  const env = await routerEnv($, mode)
  const started = await $.clock.now()
  if ((await read($, routerAtom)).epoch !== switched.epoch) return `ROUTER / ${routerLine(await read($, routerAtom))}`
  const [answer = null] = await askRouter($, mode, [probe.body], env)
  const wall = (await $.clock.now()) - started
  const isUp = answer !== null && answer.provider === PROVIDER[mode] && answer.failure === null && answer.choice !== null
  const detail = isUp ? `${answer.model ?? PROVIDER[mode]} · ${wall}ms` : answer === null ? 'no answer' : answer.failure ?? `answered by ${answer.provider}`
  const now = await update($, routerAtom, s => s.epoch !== switched.epoch ? s : { ...s, link: isUp ? 'connected' as const : 'unavailable' as const, detail })

  return [
    `ROUTER / ${routerLabel(now)}${isUp ? ` · ${detail}` : ''}`,
    mode === 'JEV'
      ? `JEV is the TypeSafe API, reached through the local decision router${dir.dir !== null ? ` with the router configuration at ${dir.dir} (routerConfigDir)` : dir.refused !== null ? ` under its own JEV switch: routerConfigDir was NOT used because ${dir.refused}` : ' under its own JEV switch (no routerConfigDir is set)'}. Each prompt you submit outside a planned task counts as a new task: when the rules do not settle it, its first 400 characters are sent to JEV in ten small requests. Nothing else is sent, and a prompt in which credential-shaped text is recognised is withheld (a pattern list, not a guarantee: do not paste secrets).`
      : 'NobodyWho is asked through the local decision router with its local provider only (--mode local); an answer from any other provider is discarded. Each prompt you submit outside a planned task counts as a new task and is asked about when the rules do not settle it.',
    'Advisory only: Cockpit\'s rules still decide admission, ownership, mandatory consultations and verification gates. This session only; a new session starts OFF.',
  ].join('\n')
}

/** The engine's own dialog for the three modes; null when dismissed or when there is no one to ask. */
const pickRouter = async ($: EngineInterface, current: RouterMode): Promise<RouterMode | null> => {
  try {
    await update($, visualAtom, old => ({ ...old, waiting: old.waiting + 1 }))
    stopTicker()
    try {
      return routerModeOf(await $.ui.ask(`Which router should advise this session? (now ${current})`, { options: [...ROUTER_MODES], header: 'Router' }))
    } finally {
      await update($, visualAtom, old => ({ ...old, waiting: Math.max(0, old.waiting - 1) }))
    }
  } catch { return null }
}

const ask = async ($: EngineInterface, question: string, header: string, choices: readonly [string, string]): Promise<string | null> => {
  try {
    await update($, visualAtom, old => ({ ...old, waiting: old.waiting + 1 }))
    stopTicker()
    try {
      return await $.ui.ask(question, { options: choices, header })
    } finally {
      await update($, visualAtom, old => ({ ...old, waiting: Math.max(0, old.waiting - 1) }))
    }
  } catch {
    // dismissed, or nobody to ask (a headless run): the cautious answer
    return null
  }
}

const quote = (text: string): string => JSON.stringify(oneLine(text, 90))

const confirmDestructive = async (
  $: EngineInterface,
  command: string,
  findings: GuardFinding[],
  isSubagent: boolean,
): Promise<boolean> => {
  // the panel drawn above the dialog carries the detail; the question stands alone without it
  const titles = findings.map(one => one.title).join(', ')
  const question = `Destructive: ${oneLine(titles, 80)}. Run ${quote(command)}?`
  const request: GuardRequest = { question, command, findings, isSubagent, at: await $.clock.now() }
  await quiet(() => update($, guardsAtom, list => [...list, request].slice(-4)))
  // Cancel is listed first, so a reflexive Enter does not run it
  const answer = await ask($, question, GUARD_HEADER, [CANCEL, PROCEED])
  await quiet(() => update($, guardsAtom, list => list.filter(one => one.question !== question)))

  return answer === PROCEED
}

const attributionDeny = (found: Attribution, where: string): { deny: string } => ({
  deny: `Cobalt Cockpit: ${where} would add AI attribution (${quote(found.line)}). This user's repositories carry none. Do it again without that text.`,
})

const allowInstructionFile = async ($: EngineInterface, path: string): Promise<{ deny: string } | null> => {
  const absolute = path.startsWith('/') ? path : `${cwd}/${path}`
  const hasFile = await $.fs.exists(absolute).catch(() => true)
  const task = await read($, taskAtom)
  if (hasFile || task?.hasInstructionFileRequest === true) return null
  const name = basename(path)
  const answer = await ask(
    $,
    `Claude is about to create ${name} at ${oneLine(absolute, 80)}, which you did not ask for. Create it?`,
    'New file',
    ['Block', 'Create'],
  )
  if (answer === 'Create') return null

  return {
    deny: `Cobalt Cockpit: ${name} is only created when the user asks for one in this repository, and the user has not. It was not written. Do not create it another way; say so if you think one would help.`,
  }
}

/** The guards: a `{ deny }` when the call must not run, else null. */
const guard = async ($: EngineInterface, e: { tool: string; agentId?: string } & Record<string, unknown>): Promise<{ deny: string } | null> => {
  if (e.tool === 'Bash') {
    const command = typeof e['command'] === 'string' ? e['command'] : ''
    if (config.hasAttributionGuard) {
      const found = attributionInCommand(command)[0]
      if (found !== undefined) return attributionDeny(found, 'this command')
      for (const path of instructionFilesWritten(command)) {
        const refusal = await allowInstructionFile($, path)
        if (refusal !== null) return refusal
      }
    }
    if (config.hasGuard) {
      const findings = assessCommand(command, { cwd, home })
      if (findings.length > 0 && !(await confirmDestructive($, command, findings, e.agentId !== undefined))) {
        return {
          deny: `Cobalt Cockpit: the user did not approve this destructive command (${findings
            .map(one => one.title)
            .join(', ')}). It did not run. Do not retry it or reach the same effect another way; ask the user how to proceed.`,
        }
      }
    }

    return null
  }

  if (!config.hasAttributionGuard || (e.tool !== 'Edit' && e.tool !== 'Write' && e.tool !== 'NotebookEdit')) return null
  const path = String(e['file_path'] ?? e['notebook_path'] ?? '')
  // this plugin's own sources and tests spell the patterns out
  if (path === '' || path.startsWith(`${$.plugin.root}/`)) return null
  const after = String(e['new_string'] ?? e['content'] ?? e['new_source'] ?? '')
  let added: Attribution[] = []
  if (e.tool === 'Edit') {
    added = addedAttribution(String(e['old_string'] ?? ''), after)
  } else if (findAttribution(after).length > 0) {
    const before = e.tool === 'Write' ? await $.fs.read(path).catch(() => '') : ''
    added = addedAttribution(before, after)
  }
  const trailer = added.find(one => one.kind === 'trailer')
  if (trailer !== undefined) return attributionDeny(trailer, `this edit to ${basename(path)}`)
  const phrase = added[0]
  if (phrase !== undefined) {
    const answer = await ask(
      $,
      `This edit adds a line to ${basename(path)} that reads as AI attribution: ${quote(phrase.line)}. Keep it out of the repository?`,
      'Attribution',
      ['Block', 'Allow once'],
    )
    if (answer !== 'Allow once') return attributionDeny(phrase, `this edit to ${basename(path)}`)
  }
  if (e.tool === 'Write' && isInstructionFile(path)) return allowInstructionFile($, path)

  return null
}

/**
 * A fingerprint of the project's working tree, from git, that depends on file contents and not on how git
 * stages them: every file that differs from the commit it was taken against (changed, staged, or untracked)
 * with the hash of its content, and the paths deleted. A commit, an add or a stash therefore leaves it
 * unchanged, and any tool that changes a tracked or unignored file changes it, whatever the tool is called and
 * whether or not it reports a diff. A read does not. It is `base:hash`; `base` is the commit it is measured
 * against and is passed back to measure the same way later. Null where there is no repository, no commit yet,
 * a git command failed, was cut short or timed out, or more than TREE_FILES files differ; no change outside
 * Edit, Write and a Bash edit diff can then be observed. Ignored files are not seen.
 */
const TREE_FILES = 2000
const treeStamp = async ($: EngineInterface, base?: string): Promise<string | null> => {
  try {
    const sh = async (argv: string[]): Promise<string | null> => {
      const r = await $.process.run(['git', '--no-optional-locks', ...argv], { timeoutMs: GIT_TIMEOUT_MS })

      return r.exitCode === 0 && !r.isStdoutTruncated ? r.stdout : null
    }
    const top = (await sh(['rev-parse', '--show-toplevel']))?.trim()
    if (!top) return null
    const at = (...argv: string[]) => sh(['-C', top, ...argv])
    const head = base ?? (await at('rev-parse', '--verify', 'HEAD'))?.trim()
    if (!head) return null
    const changed = await at('diff', head, '--no-renames', '--name-only', '-z', '--diff-filter=d')
    const deleted = await at('diff', head, '--no-renames', '--name-only', '-z', '--diff-filter=D')
    const untracked = await at('ls-files', '-o', '--exclude-standard', '-z')
    if (changed === null || deleted === null || untracked === null) return null
    const paths = [...new Set([...changed.split('\0'), ...untracked.split('\0')].filter(Boolean))].sort()
    if (paths.length > TREE_FILES) return null
    const lines: string[] = [...deleted.split('\0').filter(Boolean).sort().map(path => `D\0${path}`)]
    for (let i = 0; i < paths.length; i += 100) {
      const chunk = paths.slice(i, i + 100)
      const hashes = await at('hash-object', '--no-filters', '--', ...chunk)
      const got = hashes?.split('\n').filter(Boolean)
      if (got === undefined || got.length !== chunk.length) return null
      chunk.forEach((path, n) => lines.push(`${got[n]}\0${path}`))
    }
    const text = lines.join('\n')
    // FNV-1a twice with different seeds: a change detector, not a security boundary. Paths and hashes never leave this function.
    let a = 0x811c9dc5, b = 0x01000193
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193) >>> 0; b = Math.imul(b + c, 0x85ebca6b) >>> 0 }

    return `${head}:${lines.length}.${a.toString(16)}${b.toString(16)}`
  } catch {
    return null
  }
}
const baseOf = (stamp: string | undefined): string | undefined => (typeof stamp === 'string' && stamp.includes(':') ? stamp.slice(0, stamp.indexOf(':')) : undefined)

/** If a goal check was accepted for another working tree than the present one, it is stale now. */
const reconcileOnce = async ($: EngineInterface): Promise<void> => {
  const task = await read($, taskAtom)
  const accepted = task?.alignment?.tree
  if (task?.alignment?.state !== 'ALIGNED' || typeof accepted !== 'string') return
  const tree = await treeStamp($, baseOf(accepted))
  if (tree === null || tree === accepted) return
  const now = await $.clock.now()
  // only the check that was measured: one made since is about a newer tree
  const held = await update($, taskAtom, t => (t === null || t.alignment?.tree !== accepted ? t : settle(treeMoved(t, tree)).task))
  if (held !== null) await quiet(async () => { await mutateLedger($, l => recordDiscovery(l, held, now)); await persist($) })
}
// One measurement at a time; calls that arrive while one runs share the next, which starts after they did.
let reconciling: Promise<void> | null = null
let reconcileNext: Promise<void> | null = null
const reconcileTree = ($: EngineInterface): Promise<void> => {
  if (reconciling === null) {
    reconciling = reconcileOnce($).finally(() => { reconciling = null })

    return reconciling
  }
  reconcileNext ??= reconciling.then(() => { reconcileNext = null; return reconcileTree($) }, () => { reconcileNext = null; return reconcileTree($) })

  return reconcileNext
}

const serveProgress = async ($: EngineInterface, e: ProgressInput & { agentId?: string }): Promise<{ result: string }> => {
  if (e.agentId !== undefined) {
    return {
      result: 'Cobalt Cockpit: the task state belongs to the main conversation. Report your result to it instead; nothing was changed.',
    }
  }
  const now = await $.clock.now()
  const sha = (await read($, gitAtom))?.sha ?? null
  await quiet(() => reconcileTree($))
  await quiet(() => syncRelease($))
  await quiet(() => reconcileRelease($))
  // the tree an accepted goal check is about, taken before the answer is recorded
  const before = e.action === 'align' || e.action === 'gate' || (e.action as string) === 'gates' ? await read($, taskAtom) : null
  const goalChecked = before !== null && needsAlignment(before)
  const stamp = goalChecked && e.action === 'align' ? await treeStamp($, baseOf(before.gateTree)) : null
  const gateStamp = goalChecked && (e.action === 'gate' || (e.action as string) === 'gates') ? await treeStamp($, baseOf(before.gateTree)) : null
  let reply = ''
  let unprotected = ''
  let cues: Cue[] = []
  let wasDone = false
  const pin = await read($, discoveryPinAtom)
  const held = await update($, taskAtom, old => {
    cues = []
    wasDone = old?.status === 'done'
    // the passed checks must be about the tree the goal check is made for
    if (e.action === 'align' && old !== null && stamp !== null && old.gateTree !== undefined && old.gateTree !== stamp) {
      reply = 'error: ALIGNED refused: the working tree changed after the checks were last observed, so they no longer describe it. Run the checks again, record the gates, then align. Nothing was recorded'

      return reopenVerification(old, 'the working tree changed since the checks were observed')
    }
    const outcome = applyAction(old === null ? newTask(1, '', now, sha) : checkedAt(old, gateStamp), e, now, sha)
    if (outcome.error !== undefined) {
      reply = `error: ${outcome.error}`

      return old
    }
    // The person's pin and the evidence of the plan are applied before the task is settled, so the goal check counts toward DONE.
    // A task stored by v0.5.0 (milestones, no discovery) keeps the rules it began under, unless this call starts a new one.
    const isLegacy = old !== null && old.milestones.length > 0 && old.discovery === undefined && e.action !== 'plan'
    const gated = e.action === 'gate' || (e.action as string) === 'gates' ? stampGates(outcome.task, gateStamp) : outcome.task
    const stamped = stamp !== null && gated.alignment?.state === 'ALIGNED' ? { ...gated, alignment: { ...gated.alignment, tree: stamp } } : gated
    if (goalChecked && e.action === 'align' && stamp === null && gated.alignment?.state === 'ALIGNED') unprotected = 'No working-tree fingerprint could be taken here (no git repository, no commit, or git did not answer), so a later change outside Edit, Write and Bash edit diffs will not be noticed.'
    const settled = settle(isLegacy ? stamped : withDiscovery(stamped, pin))
    cues = settled.cues
    reply = [outcome.note, unprotected, summaryOf(settled.task)].filter(Boolean).join(' ')

    return settled.task
  })
  for (const cue of cues) void sound($, cue)
  if (held !== null) await quiet(async () => { await mutateLedger($, l => recordDiscovery(l, held, now)); await persist($) })
  // a task is counted when it first reads DONE; an Opus consultation is one the ledger admitted for this task
  if (held !== null && held.status === 'done' && held.percent === 100 && !wasDone) await quiet(async () => tele($, { k: 'task', opus: ((await read($, ledgerAtom)).consults ?? []).some(c => c.progressTask === held.id) }))

  return { result: reply }
}

const relative = (path: string): string => (cwd !== '' && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)

/** A tool call of the main loop begins: what the HUD says Claude is doing. */
const noteStart = async ($: EngineInterface, e: { tool: string; tool_use_id: string; agentId?: string } & Record<string, unknown>) => {
  const now = await $.clock.now()
  const agentId = e.agentId
  if (agentId !== undefined) {
    const doing = activityOf(e.tool, e).kind
    const count = (await read($, ledgerAtom)).agents.find(a => a.id === agentId)?.counts.tools
    await editAgent($, agentId, a => ({ ...a, state: 'running', tool: e.tool, kind: doing, toolCount: count ?? a.toolCount }))
    // a subagent's work is counted apart: it never moves the task
    const activity = await read($, activityAtom)
    if (!activity.agents.includes(agentId)) {
      await update($, activityAtom, old => (old.agents.includes(agentId) ? old : { ...old, agents: [...old.agents, agentId].slice(-16) }))
    }

    return
  }
  const { kind, detail } = activityOf(e.tool, e)
  await update($, activityAtom, old => ({ ...old, kind, detail, isWorking: true, toolUseId: e.tool_use_id, at: now }))
  await change($, task => {
    const noted = { ...task, lastAction: { at: now, text: oneLine(`${kind} ${detail}`, 80) } }
    if (task.milestones.length > 0) return noted
    // no plan: the phase is read off what is actually being done
    const phase =
      kind === 'EDIT' ? 'IMPLEMENT' : kind === 'TEST' ? 'TEST' : kind === 'PLAN' ? 'PLAN' : kind === 'READ' || kind === 'WEB' ? 'RESEARCH' : task.phase

    return { ...noted, phase }
  })
  startTicker($)
}

/** The call returned: gates from real results, files touched, a fresh look at the repository. */
const noteEnd = async (
  $: EngineInterface,
  e: { tool: string; tool_use_id: string; agentId?: string } & Record<string, unknown>,
  ran: { deny?: string | undefined; isError?: boolean | undefined; result?: unknown },
) => {
  if (e.agentId !== undefined) {
    // A helper's edit never moves the task, but it does make an earlier goal check stale.
    const made = (ran.deny === undefined && ran.isError !== true ? ran.result : null) as Record<string, unknown> | null
    const now = await $.clock.now()
    const wrote = made !== null && made['staged'] !== true && (e.tool === 'Edit' || e.tool === 'Write' || (e.tool === 'Bash' && Array.isArray((made['bashEditDiff'] as { files?: unknown } | undefined)?.files)))
    if (wrote) {
      await quiet(async () => {
        const held = await change($, task => reopenVerification({ ...task, edited: true }, 'a helper changed files'))
        if (held !== null) await mutateLedger($, l => recordDiscovery(l, held, now))
      })
    }
    if (ran.deny === undefined && e.tool !== TOOL) await quiet(() => reconcileTree($))

    return
  }
  const result = (ran.deny === undefined && ran.isError !== true ? ran.result : null) as Record<string, unknown> | null
  const edits: { path: string; added: number; removed: number }[] = []
  if ((e.tool === 'Edit' || e.tool === 'Write') && result !== null && result['staged'] !== true) {
    const path = String(result['filePath'] ?? e['file_path'] ?? '')
    // a new file has no patch: every line of it was added
    const counts =
      result['type'] === 'create' && typeof result['content'] === 'string'
        ? { added: result['content'].replace(/\n$/, '').split('\n').length, removed: 0 }
        : countPatch(result['structuredPatch'])
    if (path !== '') edits.push({ path: relative(path), ...counts })
  }
  if (e.tool === 'Bash' && result !== null) {
    const files: unknown = (result['bashEditDiff'] as { files?: unknown } | undefined)?.files
    for (const file of Array.isArray(files) ? files : []) {
      const path = String((file as { filePath?: unknown }).filePath ?? '')
      if (path !== '') edits.push({ path: relative(path), ...countPatch((file as { hunks?: unknown }).hunks) })
    }
  }
  const readings =
    e.tool === 'Bash' && ran.deny === undefined
      ? readBash(String(e['command'] ?? '')).read(
          ran.isError === true
            ? 'error'
            : result !== null && (result['backgroundTaskId'] !== undefined || result['interrupted'] === true)
              ? 'unknown'
              : 'ok',
        )
      : []

  const observed = readings.some(r => r.state === 'pass') ? await treeStamp($, baseOf((await read($, taskAtom))?.gateTree)) : null
  if (edits.length > 0 || readings.length > 0) {
    await change($, (task, now) => {
      let chain = task
      for (const edit of edits) chain = touchFile(chain, edit.path, edit.added, edit.removed)
      if (observed !== null) chain = checkedAt(chain, observed)
      if (edits.length > 0 && isSonnetLed()) chain = requireReview(chain, mandatoryGrounds(factsOf({ ...chain, files: chain.files.map(f => ({ ...f, path: relative(f.path) })) }, 0, chain.promptGrounds ?? [])))
      for (const reading of readings) chain = setGate(chain, reading.gate, reading.state, reading.evidence, 'auto', now)
      if (observed !== null) chain = stampGates(chain, observed)

      return chain
    })
  }
  // The failure streak: the same check failing again, or the same tool erroring
  // again. A refused call ran nothing and says nothing about either.
  if (config.hasOrchestration && ran.deny === undefined && e.tool !== TOOL) {
    const failing = readings.filter(one => one.state === 'fail').map(one => one.gate)
    const passing = readings.filter(one => one.state === 'pass').map(one => one.gate)
    const failed = failing.length > 0 || (ran.isError === true && readings.length === 0)
    // a check whose result is masked settles nothing, and neither lengthens nor ends a streak
    if (failed || passing.length > 0 || readings.length === 0) {
      const key = outcomeKey(e.tool, e, failed ? failing : passing)
      const at = await $.clock.now()
      const held = await read($, orchestraAtom)
      if (noteOutcome(held, key, failed, at) !== held) await update($, orchestraAtom, old => noteOutcome(old, key, failed, at))
    }
  }
  const activity = await read($, activityAtom)
  if (activity.toolUseId === e.tool_use_id) {
    await update($, activityAtom, (old): Activity =>
      old.toolUseId === e.tool_use_id ? { ...old, kind: old.isWorking ? 'THINK' : 'IDLE', detail: '', toolUseId: null } : old,
    )
  }
  // Whatever else a tool did to the project, a goal check made for another tree is stale.
  if (ran.deny === undefined && e.tool !== TOOL) { await quiet(() => reconcileTree($)); await quiet(() => reconcileRelease($)) }
  scheduleGit($)
  void refreshMeter($)
}

const hudInput = async ($: EngineInterface, isWorking: boolean): Promise<HudInput> => ({
  task: await read($, taskAtom),
  activity: await read($, activityAtom),
  git: await read($, gitAtom),
  meter: await read($, meterAtom),
  isWorking,
})

/**
 * What the crawler is allowed to know this frame, and the state it derived.
 *
 * Every field is read from state the host already reported. `progress` comes
 * from `settle`, which refuses to call a task 100% until its gates really
 * passed, so the crawler cannot be shown a completion that did not happen.
 */
const crawlerOf = async ($: EngineInterface, input: HudInput, visual: Visual, waiting: boolean): Promise<{ crawler: CrawlerInput; newest: NwhoEvent | null }> => {
  const settled = input.task === null ? null : settle(input.task).task
  // The same three facts `visualStateOf` believes, read the same way, so the
  // crawler can never disagree with the HUD's own state word.
  const failed =
    input.task?.milestones.some(m => m.state === 'failed') === true ||
    Object.values(input.task?.gates ?? {}).some(g => g.state === 'fail') ||
    ((input.task?.failures.length ?? 0) > 0 && input.task?.phase === 'FIX')
  const observations: Observations = {
    phase: input.task?.phase ?? 'RESEARCH',
    progress: (settled?.percent ?? 0) / 100,
    hasTask: input.task !== null,
    allGatesPassed: settled !== null && settled.status === 'done',
    isDone: input.task?.status === 'done' && settled?.status === 'done' && settled.percent === 100,
    activity: input.activity.kind === 'IDLE' ? null : input.activity.kind,
    failed,
    waiting,
    // `isWorking` is the band's own flag, which is what the HUD's state word is
    // derived from too: a turn that has started but has not reached a tool is a
    // scan here and a glitch in the panel, and the two can never disagree.
    isWorking: input.isWorking,
  }
  const now = await $.clock.now()
  const flash = await read($, flashAtom)
  const control = await read($, controlAtom)
  const strength = flashStrength(flash, now, reducedMotion)
  // Only the newest live receipt drives the layer, and only while it is live.
  const newest = control.lastPrune !== null && (control.lastDecision === null || control.lastPrune.at >= control.lastDecision.at) ? control.lastPrune : control.lastDecision
  const live = newest !== null && strength > 0

  return {
    crawler: {
      state: stateOf(observations),
      progress: observations.progress,
      milestones: input.task?.milestones.length ?? 0,
      activity: observations.activity ?? '',
      nwhoTier: live ? newest?.tier ?? null : null,
      nwhoOp: live ? newest?.op ?? null : null,
      nwhoStrength: live ? strength : 0,
    },
    newest: live ? newest : null,
  }
}

/**
 * The NobodyWho layer for a frame.
 *
 * A prune draws only branches, a decision only a junction, and an absent or
 * faded receipt draws nothing at all. The counts come from the receipt that
 * actually arrived, so a branch is only ever drawn for a block the router
 * really judged and really dropped.
 */
const layerFor = (crawler: CrawlerInput, newest: NwhoEvent | null): NwhoLayer =>
  newest === null ? NO_NWHO : layerOf(crawler, newest.accepted, newest.rejected)

/**
 * Records that one startup module really finished initializing.
 *
 * The step is appended only once, so a hot reload that re-runs `register` does
 * not double-count, and the sequence's own progress can never exceed the work
 * that actually happened.
 */
const markStartup = async ($: EngineInterface, step: string): Promise<void> => {
  const done = await read($, startupAtom)
  if (done.includes(step)) return
  await update($, startupAtom, old => (old.includes(step) ? old : [...old, step]))
}

/** Drops the init line the moment real work begins, so it never lingers. */
const dismissStartup = ($: EngineInterface) => quiet(async () => {
  if ((await read($, startupAtom)).length > 0) await update($, startupAtom, () => [])
})

export const ledgerAtom = atom({ plugin: 'cobalt-cockpit', key: 'run-ledger' } as const, emptyLedger())
const positionAtom = atom({ plugin: 'cobalt-cockpit', key: 'replay-position' } as const, 0)
const resumeAtom = atom({ plugin: 'cobalt-cockpit', key: 'ledger-resume' } as const, false)
const LEDGER_PANE = 'cobalt-run-ledger'
const REPLAY_PANE = 'cobalt-replay'
const STORE_MAX_SESSIONS = 8
const hush = async (work: () => Promise<unknown>) => { try { await work() } catch { /* bookkeeping never fails an engine action */ } }
export const mutateLedger = async ($: EngineInterface, f: (l: Ledger) => Ledger): Promise<void> => {
  const old = await read($, ledgerAtom)
  if (f(old) !== old) await update($, ledgerAtom, f)
}
export const ledgerSpawn = async ($: EngineInterface, e: { subagentType: string; description: string; model?: string; parentAgentId?: string; background: boolean; parentModel: string; provider: { plugin: string } }, spawned: { agentId?: string; model?: string; deny?: string }, originLedger?: Ledger, spawnAt?: number): Promise<void> => {
  if (!spawned.agentId) return
  const at = spawnAt ?? await $.clock.now()
  const origin = originLedger === undefined ? undefined : originOf(originLedger, e.parentAgentId)
  const originTurn = originLedger?.turns[e.parentAgentId ?? 'main']
  await mutateLedger($, l => addAgent({ ...l, runs: l.runs.map(r => e.parentAgentId === undefined && r.id === (origin ?? l.currentRun) && r.model === UNKNOWN ? { ...r, model: word(e.parentModel) } : r) }, { agentId: spawned.agentId!, subagentType: e.subagentType, description: e.description, requestedModel: e.model, model: spawned.model, parentAgentId: e.parentAgentId, background: e.background, source: e.provider.plugin, originRun: origin, originTurn }, at))
  await persist($)
}
const adoptLedgerAgents = async ($: EngineInterface): Promise<void> => {
  const listed = await $.agent.list()
  const at = await $.clock.now()
  await changeSwarm($, held => {
    let chain = held
    for (const info of listed) {
      const t = chain.tasks.find(t=>t.agentId === info.id && !['completed','failed','cancelled'].includes(t.state))
      if (t && ['completed','failed','error','cancelled','aborted'].includes(info.status)) {
        chain = finishObserved(chain,t.id,info.status,'Host reports stopped; result unavailable',at)
      }
    }
    return markStalled(chain,at)
  })
  await mutateLedger($, l => listed.reduce((chain, info) => adoptAgent(chain, info), l))
}
export const ledgerRequest = async ($: EngineInterface, e: { turnId: string; index: number; agentId?: string; model: string; effort?: unknown }, actual: { model?: string; effort?: unknown; usage?: unknown; routingReason?: string; fallbackReason?: string | null; via?: 'host' | 'hook' }, warning?: string | null): Promise<void> => {
  if (e.agentId && !(await read($, ledgerAtom)).agents.some(a => a.id === e.agentId)) await hush(() => adoptLedgerAgents($))
  await mutateLedger($, l => {
    const noted = recordRequest(l, e, { ...actual, usage: actual.usage as Record<string, unknown> | null })
    return warning ? warn(noted, warning) : noted
  })
  // one observed request, as the ledger now holds it; tokens only when the host reported both figures
  await hush(async () => {
    const r = (await read($, ledgerAtom)).requests.at(-1)
    if (r === undefined) return
    const raw = (typeof actual.usage === 'object' && actual.usage !== null ? actual.usage : {}) as Record<string, unknown>
    const split = (typeof raw['cache_creation'] === 'object' && raw['cache_creation'] !== null ? raw['cache_creation'] : {}) as Record<string, unknown>
    await tele($, {
      k: 'req', tier: modelTier(r.model), sub: e.agentId !== undefined,
      ...(typeof r.input === 'number' && typeof r.output === 'number' ? { inTok: r.input, outTok: r.output } : {}),
      ...(typeof r.cacheRead === 'number' && typeof r.cacheWrite === 'number' ? { cr: r.cacheRead, cw: r.cacheWrite } : {}),
      // the 5m / 1h split exists only if the host passed it through; the typed usage does not carry it
      ...(typeof split['ephemeral_5m_input_tokens'] === 'number' && typeof split['ephemeral_1h_input_tokens'] === 'number' ? { w5: split['ephemeral_5m_input_tokens'], w1: split['ephemeral_1h_input_tokens'] } : {}),
      ...(e.agentId !== undefined && cacheReading !== null ? { pol: cacheReading.ttl } : {}),
    })
  })
  await persist($)
}
const persist = async ($: EngineInterface): Promise<void> => {
  const ledger = await read($, ledgerAtom)
  if (ledger.sessionId === UNKNOWN) return
  await $.store.set(`ledger:${ledger.sessionId}`, storageLedger(ledger))
  const index = (await $.store.get('ledger-index')) as string[] | undefined
  const ids = [...(Array.isArray(index) ? index.filter(s => typeof s === 'string' && s !== ledger.sessionId) : []), ledger.sessionId]
  for (const old of ids.slice(0, -STORE_MAX_SESSIONS)) await $.store.delete(`ledger:${old}`)
  await $.store.set('ledger-index', ids.slice(-STORE_MAX_SESSIONS))
}
const checkpoint = async ($: EngineInterface) => {
  const task = (await read($, { plugin: 'cobalt-cockpit', key: 'task' })) ?? null
  const git = (await read($, { plugin: 'cobalt-cockpit', key: 'git' })) ?? null
  const at = await $.clock.now()
  await mutateLedger($, l => ({ ...l, checkpoint: checkpointOf(l, task, git, at) }))
  await persist($)
}
const sample = async ($: EngineInterface) => {
  const usage = await $.session.usage()
  const at = await $.clock.now()
  await mutateLedger($, l => reading(l, usage.context, at))
}
const restore = async ($: EngineInterface) => {
  const id = (await $.session.id().catch(() => UNKNOWN)) || UNKNOWN
  const held = await read($, ledgerAtom)
  const stored = await $.store.get(`ledger:${id}`) as Ledger | undefined
  if (held.sessionId !== id) {
    await mutateLedger($, () => stored && (stored.schema === 1 || stored.schema === 2) && stored.sessionId === id ? migrateLedger(stored) : emptyLedger(id))
    if (stored?.checkpoint) {
      await update($, resumeAtom, () => true)
      await $.ui.toast(`COBALT / RESUME · ${stored.checkpoint.phase} · ${stored.checkpoint.remaining.length} milestones remaining`, { timeoutMs: 8000 })
    }
  } else if (!held.swarm || held.schema === 1) await mutateLedger($, migrateLedger)
}
export const ledgerStart = async ($: EngineInterface) => {
      await hush(() => restore($))
      await hush(() => adoptLedgerAgents($))
      for (const name of ['ledger', 'replay', 'park']) await hush(() => $.command.register({ name, description: name === 'ledger' ? 'Cobalt Control / Run Ledger; export json' : name === 'replay' ? 'Successful repository deltas' : 'Deterministic checkpoint', immediate: true }))
      await hush(() => sample($))
    }
export const ledgerTurnStart = async ($: EngineInterface, turnId: string) => { await hush(async () => { await restore($); const at = await $.clock.now(); await mutateLedger($, l => startRun(l, turnId, at)) }) }
export const ledgerTurnComplete = async ($: EngineInterface, e: { turnId: string; agentId?: string; reason: string; answer?: string }) => {
  await hush(async () => {
    const at = await $.clock.now()
    const first = e.agentId === undefined ? undefined : !(await read($, ledgerAtom)).observedCompletions?.some(c => c.agentId === e.agentId)
    await mutateLedger($, l => {
      const ended = finishTurn(l,e,at)
      if (!e.agentId) return ended
      // the stored conclusion is one folded, shortened line; the DECISION line is read from the answer as given
      const decision = releaseDecision(e.answer)
      const first = ended.observedCompletions?.find(c => c.agentId === e.agentId)
      const owner = swarmState(ended).tasks.find(t => t.agentId === e.agentId)
      // An architect that has already returned is not asked again for approval: a later turn of the same agent (a message
      // sent to it, a resume) is kept beside its answer as separate information and changes neither the recorded decision
      // nor the consultation's state.
      if (first !== undefined && owner !== undefined && owner.tier === 'OPUS' && hasReturned(owner)) {
        const later = { at, reason: e.reason, conclusion: textOf(e.answer), ...(decision === undefined ? {} : { decision }) }

        return { ...ended, observedCompletions: (ended.observedCompletions ?? []).map(c => c === first ? { ...c, later: [...(c.later ?? []), later].slice(-4) } : c) }
      }
      const completed = [...(ended.observedCompletions ?? []).filter(c=>c.agentId!==e.agentId), { agentId:e.agentId,reason:e.reason,conclusion:textOf(e.answer),at,...(decision === undefined ? {} : { decision }) }].slice(-128)
      const task = swarmState(ended).tasks.find(t=>t.agentId===e.agentId)
      return { ...ended, observedCompletions:completed, swarm:task ? finishObserved(swarmState(ended),task.id,e.reason,textOf(e.answer),at) : swarmState(ended) }
    })
    // a subagent's first end is one observed ending, with its lifetime by the plugin's clock; a later turn of the same agent is not another
    if (e.agentId !== undefined && first === true) await hush(async () => {
      const l = await read($, ledgerAtom)
      const agent = l.agents.find(a => a.id === e.agentId)
      const started = typeof agent?.start === 'number' ? agent.start : null
      await tele($, { k: 'agent', tier: modelTier(agent?.model), role: agentRole(agent?.role), ok: e.reason === 'answer', ms: started === null ? null : Math.max(0, at - started) })
      const owner = swarmState(l).tasks.find(t => t.agentId === e.agentId)
      const consult = owner?.tier === 'OPUS' ? l.consults?.find(c => c.id === owner.id) : undefined
      if (consult !== undefined) await tele($, { k: 'consult', ground: consult.ground, ev: 'returned', mandatory: consult.isMandatory, ms: Math.max(0, at - consult.requestedAt) })
    })
    if (!e.agentId) await sample($)
    await checkpoint($)
  })
}
export const ledgerEnd = async ($: EngineInterface) => { await hush(() => checkpoint($)) }
export const ledgerMeasure = async ($: EngineInterface) => { await hush(() => sample($)) }
export const ledgerPrompt = async ($: EngineInterface) => { await hush(() => update($, resumeAtom, () => false)) }
export const ledgerToolStart = async ($: EngineInterface, call: Record<string, unknown>) => { await hush(async () => { const at = await $.clock.now(); await mutateLedger($, l => beginTool(l, call, at)) }) }
export const ledgerToolEnd = async ($: EngineInterface, call: Record<string, unknown>, r: { deny?: string; isError?: boolean; result?: unknown }, before?: string) => {
      await hush(async () => {
        const end = await $.clock.now(), id = String(call['tool_use_id']), tool = call['tool']
        const failed = r.deny !== undefined || r.isError === true
        await mutateLedger($, l => finishTool(l, id, failed, end))
        const result = r.result as { staged?: boolean } | undefined
        if (!failed && result?.staged !== true && (tool === 'Edit' || tool === 'Write')) {
          const oldText = tool === 'Edit' ? call['old_string'] : before, newText = tool === 'Edit' ? call['new_string'] : call['content']
          await mutateLedger($, l => {
            const origin = l.tools.find(t => t.id === id)
            return withReplay(l, { id, runId: origin?.runId ?? UNKNOWN, turnId: origin?.turnId ?? UNKNOWN, agentId: typeof call['agentId'] === 'string' ? call['agentId'] : UNKNOWN, file: safeFile(call['file_path']), kind: tool, at: end, before: typeof oldText === 'string' ? oldText : '', after: typeof newText === 'string' ? newText : '', scope: tool === 'Edit' ? 'fragment' : 'file', omitted: typeof oldText !== 'string' || typeof newText !== 'string' })
          })
        }
        await persist($)
      })
    }
export const ledgerBeforeWrite = async ($: EngineInterface, path: unknown): Promise<string | undefined> => {
      if (safeFile(path) === UNKNOWN) return undefined
      try { const file = String(path); if (!await $.fs.exists(file)) return ''; if ((await $.fs.stat(file)).size > STEP_BYTES) return undefined; return await $.fs.read(file) } catch { return undefined }
}

export const registerLedger = (on: On): void => {
  // The session's own start. `restore` rides on it, and a hook that fails
  // before `next` is skipped, so its handler lets the session start.
  on('classic.SessionStart', async ($, e, next) => {
    const ran = await next(e)
    if (e.source === 'resume') await hush(() => restore($))

    return ran
  }).catch(($, e, next) => next(e))
  on('classic.Stop', async ($, e, next) => {
    const reason = await stopGuard($, e).catch(() => null)
    // a stop that is about to be allowed is when an unfinished run needs a person
    if (reason === null) await raiseAlerts($, true)
    if (reason !== null) return { block: reason }

    return next(e)
  }).catch(($, e, next) => next(e))
  on('command.run', { command: 'park' }, async $ => {
    await checkpoint($)
    const c = (await read($, ledgerAtom)).checkpoint!
    return { text: `COBALT / PARKED · ${c.phase}\nCompleted ${c.completed.length} · remaining ${c.remaining.length} · background agents ${c.backgroundAgents.length}\nResume with Claude Code's normal session resume.` }
  }).catch(($, e, next) => next.called ? next(e) : { text: 'COBALT / the checkpoint could not be written; nothing was parked.' })
  on('command.run', { command: 'ledger' }, async ($, e) => {
    await checkpoint($)
    const l = await read($, ledgerAtom)
    if (e.args.trim() === 'export' || e.args.trim() === 'export json') return { text: exportJSON(l) }
    if (e.args.trim() === 'export decisions') return { text: decisionsMarkdown(l) }
    if (e.args.trim() !== '') return { text: 'Usage: /ledger | /ledger export json | /ledger export decisions' }
    await $.ui.open({ id: LEDGER_PANE, title: 'COBALT / RUN LEDGER', focus: true })
    return { text: 'COBALT / RUN LEDGER' }
  }).catch(($, e, next) => next.called ? next(e) : { text: 'Cobalt: the Run Ledger could not be read; nothing was opened.' })
  on('command.run', { command: 'replay' }, async $ => {
    const l = await read($, ledgerAtom)
    if (!replayTimeline(l).length) return { text: 'No successful Edit/Write snapshots observed.' }
    await update($, positionAtom, () => 0)
    await $.ui.open({ id: REPLAY_PANE, title: 'COBALT / REPLAY', focus: true })
    return { text: `COBALT / REPLAY · ${replayTimeline(l).length} steps` }
  }).catch(($, e, next) => next.called ? next(e) : { text: 'Cobalt: the replay timeline could not be read; nothing was opened.' })
  on('ui.render', { component: 'Pane', requestId: LEDGER_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const auth = await read($, { plugin: 'cobalt-cockpit', key: 'auth' })
    // The host's own /cost total where it keeps one; nothing is estimated in its place.
    const cost = isSonnetLed() ? await $.session.usage().then(u => (u.cost === undefined ? 'unavailable' : `$${u.cost.usd.toFixed(2)} (host-reported, session)`), () => 'unavailable') : undefined
    const lines = ledgerLines(await read($, ledgerAtom), await $.clock.now(), auth?.mode === 'subscription' ? 'SUBSCRIPTION' : auth?.mode === 'api' ? 'API' : UNKNOWN, cost)
    return <Box flexDirection="column">{lines.map((line, i) => <Text key={String(i)} color={/^COBALT|^\d\d /.test(line) ? COLORS.accent : undefined} wrap="truncate-end">{line}</Text>)}<Button key="close" label="Close" hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: LEDGER_PANE })} /></Box>
  })
  on('ui.render', { component: 'Pane', requestId: REPLAY_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const steps = replayTimeline(await read($, ledgerAtom))
    const pos = Math.min(await read($, positionAtom), Math.max(0, steps.length - 1))
    const step = steps[pos]
    return <Box flexDirection="column"><Text color={COLORS.accent}>{step ? `COBALT / REPLAY · ${pos + 1}/${steps.length} · ${step.title}` : 'No snapshots'}</Text>{step && step.lines.map((line, i) => <Text key={String(i)} color={line.startsWith('+') ? COLORS.ok : line.startsWith('-') ? COLORS.bad : undefined} wrap="truncate-end">{line}</Text>)}<Box flexDirection="row"><Button key="previous" label="Previous" hotkey="p" onPress={() => update($, positionAtom, n => Math.max(0, n - 1))} /><Button key="advance" label="Next" hotkey="n" onPress={() => update($, positionAtom, n => Math.min(steps.length - 1, n + 1))} /><Button key="close" label="Close" hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: REPLAY_PANE })} /></Box></Box>
  })
}

export const resumeLine = async ($: EngineInterface): Promise<string | null> => {
  if (!await read($, resumeAtom)) return null
  const c = (await read($, ledgerAtom)).checkpoint
  return c ? `COBALT / RESUME · ${c.phase} · ${c.completed.length} complete · ${c.remaining.length} remaining · /ledger` : null
}


// --- Cobalt Guard: opt-in owner alerts (policy and wording: guard.ts). Reads verification state; changes none of it. ---
const guardAtom = atom({ plugin: 'cobalt-cockpit', key: 'guard-state' } as const, EMPTY_GUARD)
let guardCfg: GuardConfig = guardConfigOf({})
let guarding = false

/** Raises whatever alert is due. Never throws, never loops, and never touches a gate, a review or an approval. */
const raiseAlerts = async ($: EngineInterface, atStop: boolean): Promise<void> => {
  if (!guardCfg.enabled || guarding) return
  guarding = true
  try {
    const task = await read($, taskAtom)
    if (task === null) return
    const history = await releaseHistorySoft($)
    const latest = [...history].sort((a, b) => b.at - a.at)[0]
    const review = task.review
    const due = dueOf({
      taskUid: uidOf(task),
      securityFailed: task.gates.SECURITY.state === 'fail',
      // only a check that really ran and kept failing is "retries exhausted"; a missing, changed or unstartable script is a blocked run
      stopBlocker: exhaustedBlocker(task.blocker),
      blocker: task.blocker,
      releaseNoGo: review !== undefined && review.grounds.includes('release') && !(review.cleared ?? []).some(c => c.ground === 'release') && latest?.outcome === 'no-go',
      reviewOpen: review !== undefined && review.state !== 'adjudicated',
      atStop,
    })
    for (const one of due) {
      const now = await $.clock.now()
      const state = await read($, guardAtom)
      const kept = (await read($, ledgerAtom)).alerts ?? []
      const decision = decideAlert(guardCfg, state, kept, one.key, now)
      if (!decision.send) {
        // an alert that is due but held back is recorded once, with the reason, so a final blocked-run alert is never lost silently
        const last = [...kept].reverse().find(a => a.key === one.key)
        if ((decision.why === 'throttled' || decision.why === 'budget') && !(last?.outcome === 'throttled' && last.why === (decision.why === 'throttled' ? 'cooldown' : 'budget'))) {
          await update($, ledgerAtom, old => ({ ...old, alerts: boundedAlerts(old.alerts ?? [], { key: one.key, kind: one.kind, taskId: task.id, at: now, outcome: 'throttled', attempts: 0, channel: null, why: decision.why === 'throttled' ? 'cooldown' : 'budget' }) }))
          await hush(() => persist($))
        }
        continue
      }
      await update($, guardAtom, old => ({ ...old, pending: true }))
      let outcome: 'sent' | 'failed' | 'refused' = 'failed'
      let channel: string | null = null
      let why: AlertRecord['why']
      try {
        const r = await $.ui.notify(alertMessage(one.kind, task.id), { title: 'Cobalt Guard' })
        if (r.isSent) { outcome = 'sent'; channel = r.channel } else { outcome = r.reason === 'refused' ? 'refused' : 'failed'; why = r.reason as AlertRecord['why'] }
      } catch { outcome = 'failed'; why = 'error' }
      await update($, guardAtom, old => ({ ...old, pending: false, sentAt: now, count: old.count + 1 }))
      await update($, ledgerAtom, old => ({ ...old, alerts: boundedAlerts(old.alerts ?? [], { key: one.key, kind: one.kind, taskId: task.id, at: now, outcome, attempts: decision.attempts, channel, ...(why === undefined ? {} : { why }) }) }))
      await hush(() => persist($))
    }
  } catch { /* an alert that cannot be raised never fails the work */ } finally {
    guarding = false
    await update($, guardAtom, old => (old.pending ? { ...old, pending: false } : old)).catch(() => undefined)
  }
}

const guardView = async ($: EngineInterface) => ({ state: await read($, guardAtom), kept: (await read($, ledgerAtom)).alerts ?? [] })


// --- Optional Stop-hook verification guard (policy and wording: stopguard.ts). ---
let stopOptions: Readonly<Record<string, unknown>> = {}
let stopCfg: StopConfig = stopConfigOf({}, null)
/** The guard's settings with ~ resolved against HOME; refreshed whenever the guard is consulted. */
const loadStopCfg = async ($: EngineInterface): Promise<StopConfig> => {
  stopCfg = stopConfigOf(stopOptions, (await $.env.get('HOME').catch(() => undefined)) ?? null)

  return stopCfg
}

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
const sha256Text = async (text: string): Promise<string> => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

/** The script's sha-256 over its raw bytes; null when it cannot be read. */
const rawSha = async ($: EngineInterface, path: string): Promise<string | null> => {
  try {
    const { base64 } = await $.fs.read(path, { as: 'bytes' })
    const bin = atob(base64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)

    return hex(await crypto.subtle.digest('SHA-256', bytes))
  } catch { return null }
}

const TRUST_KEY = 'stop-trust'
type TrustRecord = { sha: string; at: number }
const trustMap = async ($: EngineInterface): Promise<Record<string, TrustRecord>> => {
  const held = await $.store.get(TRUST_KEY).catch(() => undefined)
  const out: Record<string, TrustRecord> = {}
  if (held !== null && typeof held === 'object') {
    for (const [k, v] of Object.entries(held as Record<string, unknown>).slice(0, 32)) {
      const r = v as Partial<TrustRecord> | null
      if (typeof k === 'string' && r !== null && typeof r === 'object' && typeof r.sha === 'string' && /^[0-9a-f]{64}$/.test(r.sha) && typeof r.at === 'number') out[k] = { sha: r.sha, at: r.at }
    }
  }

  return out
}
/** Trust is per project and per script path, so it follows neither a task reset nor another repository. */
const trustScope = async ($: EngineInterface, script: string): Promise<{ key: string; verifier: string }> => {
  const cwd = (await $.session.cwd().catch(() => '')) || ''
  const key = `${cwd}\0${script}`

  return { key, verifier: (await sha256Text(key)).slice(0, 12) }
}

type TrustState = { state: 'enrolled' | 'not-enrolled' | 'changed' | 'pin-mismatch' | 'missing'; sha: string | null; verifier: string }
const trustState = async ($: EngineInterface, c: StopConfig): Promise<TrustState> => {
  const script = c.script as string
  const scope = await trustScope($, script)
  const sha = await rawSha($, script)
  if (sha === null) return { state: 'missing', sha, verifier: scope.verifier }
  if (c.pin !== null && sha !== c.pin) return { state: 'pin-mismatch', sha, verifier: scope.verifier }
  const enrolled = (await trustMap($))[scope.key]
  if (enrolled === undefined) return { state: 'not-enrolled', sha, verifier: scope.verifier }

  return { state: enrolled.sha === sha ? 'enrolled' : 'changed', sha, verifier: scope.verifier }
}
const TRUST_WORDS: Record<TrustState['state'], string> = { enrolled: 'enrolled', 'not-enrolled': 'not enrolled', changed: 'changed since it was enrolled', 'pin-mismatch': 'does not match its pin', missing: 'missing' }

/** Runs the owner's check once, on a tree that must not move. Argv only, never a shell; a refusal or failure to start is final. */
const runStopCheck = async ($: EngineInterface, task: Task, hasSummary: boolean, prior: readonly CheckRecord[]): Promise<CheckRecord> => {
  const script = stopCfg.script as string
  const at = await $.clock.now()
  const name = script.slice(script.lastIndexOf('/') + 1)
  const uid = uidOf(task)
  const trust = await trustState($, stopCfg)
  const rec = (r: Partial<CheckRecord> & Pick<CheckRecord, 'outcome'>): CheckRecord => ({ taskId: task.id, uid, verifier: trust.verifier, complete: false, name, sha: null, at, exit: null, ms: null, tree: null, summary: '', hasSummary, ...r })
  if (trust.state === 'missing') return rec({ outcome: 'missing' })
  const short = (trust.sha as string).slice(0, 8)
  if (trust.state !== 'enrolled') return rec({ outcome: 'untrusted', sha: short, summary: TRUST_WORDS[trust.state] })
  // a task keeps the verifier it started with: another script or project cannot take over its verdict
  const first = prior.find(c => c.uid === uid)
  if (first !== undefined && first.verifier !== trust.verifier) return rec({ outcome: 'untrusted', sha: short, summary: 'another verifier than the one this task started with' })
  const cwd = await $.session.cwd().catch(() => undefined)
  try {
    // A check that leaves artifacts behind (a cache directory, build output) moves the tree itself. It is run once more from
    // the tree it left, and only a tree that still moves is unstable. At most two runs; a check cannot loop here.
    let before = await treeStamp($)
    let r = await $.process.run([script], { timeoutMs: stopCfg.timeoutMs, ...(cwd === undefined ? {} : { cwd }) })
    let after = await treeStamp($)
    if (before !== null && after !== null && before !== after) {
      before = after
      r = await $.process.run([script], { timeoutMs: stopCfg.timeoutMs, ...(cwd === undefined ? {} : { cwd }) })
      after = await treeStamp($)
    }
    const ms = (await $.clock.now()) - at
    const summary = outputTail(redactSecrets(`${r.stderr}\n${r.stdout}`))
    // two fingerprints are not an atomic snapshot, but a tree seen to move while the check ran is not what was checked
    if (before !== null && after !== null && before !== after) return rec({ outcome: 'unstable', sha: short, exit: r.exitCode, ms, tree: after, summary })
    if (r.exitCode === 0) return rec({ outcome: 'pass', sha: short, exit: 0, ms, tree: after, summary })

    return rec({ outcome: ms >= stopCfg.timeoutMs ? 'timeout' : 'fail', sha: short, exit: r.exitCode, ms, tree: after, summary })
  } catch (error) {
    const text = String((error as { message?: unknown })?.message ?? '')

    return rec({ outcome: /time/i.test(text) ? 'timeout' : 'error', sha: short, summary: outputTail(redactSecrets(text)) })
  }
}

const stopGuard = async ($: EngineInterface, e: { stop_hook_active?: boolean; last_assistant_message?: string }): Promise<string | null> => {
  await loadStopCfg($)
  const task = await read($, taskAtom)
  if (stopCfg.policy !== 'ENFORCE' || stopCfg.problems.length > 0 || stopCfg.script === null || task === null) return null
  // changes the tool hooks did not see (an MCP tool, a Bash command with no edit diff) still show in the repository
  const dirty = (await read($, gitAtom))?.dirty ?? 0
  if (!hasChanges(task) && !(dirty > 0 && task.kind !== 'readonly')) return null
  const uid = uidOf(task)
  // the Ledger is where the attempts are kept, so a resumed session finds the budget as it was left
  const checks = (await read($, ledgerAtom)).stopChecks ?? []
  const spent = attemptsOf(checks, uid)
  const hasSummary = hasChangeSummary(e.last_assistant_message)
  // every check since the last one that completed the task is an attempt, whatever it said: the budget cannot be reset by a pass
  if (spent >= stopCfg.maxAttempts) return null
  // a refusal or a script that cannot start is final for this task: it is not asked again
  const lastRun = [...checks].reverse().find(c => c.uid === uid)
  if (lastRun !== undefined && (lastRun.outcome === 'error' || lastRun.outcome === 'untrusted')) return null
  const run = await runStopCheck($, task, hasSummary, checks)
  const verdict = verdictOf({ cfg: stopCfg, spent, run, hasSummary })
  const done: CheckRecord = { ...run, complete: verdict.action === 'allow' && verdict.state === 'VERIFIED' }
  await update($, ledgerAtom, old => ({ ...old, stopChecks: boundedChecks(old.stopChecks ?? [], done) }))
  await hush(() => persist($))
  const detail = run.exit === null ? run.outcome : `${run.outcome} (exit ${run.exit})`
  await change($, (t, now) => {
    let chain = t
    if (run.outcome === 'pass' && run.tree !== null) chain = checkedAt(chain, run.tree)
    if (run.outcome === 'pass' || run.outcome === 'fail' || run.outcome === 'timeout') chain = setGate(chain, 'TEST', run.outcome === 'pass' ? 'pass' : 'fail', `stop check ${run.name} ${detail}${run.tree === null && run.outcome === 'pass' ? ' (tree state unknown)' : ''}`, 'auto', now)
    if (run.outcome === 'pass' && run.tree !== null) chain = stampGates(chain, run.tree)
    if (verdict.action === 'allow' && verdict.state === 'BLOCKED') chain = blockMilestone(chain, null, BLOCKER_PREFIX + oneLine(verdict.reason, 200), now).task
    else if (verdict.action === 'allow' && verdict.state === 'VERIFIED' && chain.blocker?.startsWith(BLOCKER_PREFIX)) chain = unblock(chain, now).task

    return chain
  })

  return verdict.action === 'block' ? verdict.reason : null
}

export const register: Register = (on, options) => {
  const profile: Profile = isProfile(options['profile']) ? options['profile'] : DEFAULT_PROFILE
  const isLed = profile === 'SONNET_LED'
  config = {
    hasHud: options['hud'] !== false,
    hasFlow: options['flow'] !== false,
    isAnimated: options['animation'] !== false,
    hasSounds: options['sounds'] !== false,
    hasGuard: options['blastRadiusGuard'] !== false,
    hasAttributionGuard: options['attributionGuard'] !== false,
    volume: clampVolume(options['volume']),
    hasLocalControl: options['localControl'] !== false,
    ledgerPath: typeof options['ledgerPath'] === 'string' ? options['ledgerPath'] : '',
    blocksFable: options['cobaltStrict'] === true || options['blockFable'] === true,
    isStrict: options['cobaltStrict'] === true,
    hasOrchestration: options['cobaltStrict'] === true || options['orchestration'] === true,
    // SONNET_LED's AUTO budgets are its conservative ones; an explicit value still wins.
    maxSubagents: isLed && !(typeof options['maxSubagents'] === 'number' && options['maxSubagents'] > 0) ? (SONNET_LED_SWARM.total as number) : limitOf(options['maxSubagents']),
    maxSonnet: ((v: number | 'AUTO') => (isLed && v === 'AUTO' ? (SONNET_LED_SWARM.sonnet as number) : v))(poolBudget(options['maxSonnet'] ?? options['maxSonnetAgents'])),
    maxHaiku: ((v: number | 'AUTO') => (isLed && v === 'AUTO' ? (SONNET_LED_SWARM.haiku as number) : v))(poolBudget(options['maxHaiku'] ?? options['maxHaikuAgents'])),
    isSubscriptionOnly: options['cobaltStrict'] === true || options['subscriptionOnly'] === true,
    reasoningMode: options['reasoningMode'] === 'MANUAL' ? 'MANUAL' : 'AUTO',
    maxEffort: isEffortLevel(options['maxEffort']) ? options['maxEffort'] : DEFAULT_CEILING,
    modelEffort: parseModelEffort(options['modelEffort']),
    profile,
    routerConfigDir: typeof options['routerConfigDir'] === 'string' && /^(?:\/|~\/)[^\0\n]{1,1024}$/.test(options['routerConfigDir'].trim()) && !/(?:^|\/)\.\.(?:\/|$)/.test(options['routerConfigDir']) ? options['routerConfigDir'].trim() : '',
  }

  setTelemetry(options['telemetry'] !== false)
  stopOptions = options
  guardCfg = guardConfigOf(options)
  stopCfg = stopConfigOf(options, null)
  registerLedger(on)

  // another Cockpit that registers after this one: all the host lets a plugin see of the others
  on('plugin.register', async ($, e, next) => {
    if (e.name === 'cobalt-cockpit' && e.root !== $.plugin.root && otherCockpits.length < 8) otherCockpits.push({ root: e.root, provenance: e.provenance })

    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await quiet(async () => {
      const version = await $.session.version()
      isSupported = isAtLeast(version.base ?? version.version, MIN_VERSION)
      cacheReading = await cacheFacts($)
      hasNativeEffort = isAtLeast(version.base ?? version.version, NATIVE_EFFORT_VERSION)
      if (!isSupported) {
        $.ui.log(`cobalt-cockpit needs Claude Code ${MIN_VERSION.join('.')} or newer (this is ${version.version}); it is standing by.`)
      }
    })
    if (!isSupported) return next(e)

    // Left to the host's deferral. Listing it in the prompt (isDeferred: false)
    // was measured in v0.5.0: 768 more prompt tokens on every request and no more
    // progress reporting. What moved reporting is the one observed reminder below.
    await quiet(() => $.tool.register(PROGRESS_TOOL))
    await quiet(() => $.tool.register(SWARM_TOOL))
    await quiet(() =>
      $.command.register({
        name: 'cockpit',
        description: 'Mission Control: task progress, milestones, verification gates, git and context',
        argumentHint: '[status|reset|mute|unmute|hud on|hud off|auth|version|stats 7d|30d|all|flow|guard|doctor|sound]',
        immediate: true,
      }),
    )
    await quiet(async () => {
      const stored = (await $.store.get('prefs')) as Partial<Prefs> | undefined
      const prefs: Prefs = { isMuted: stored?.isMuted === true, isHudHidden: stored?.isHudHidden === true }
      const held = await read($, prefsAtom)
      if (held.isMuted !== prefs.isMuted || held.isHudHidden !== prefs.isHudHidden) await update($, prefsAtom, () => prefs)
    })
    await quiet(async () => {
      cwd = e.cwd
      home = (await $.env.get('HOME')) ?? ''
    })
    await quiet(async () => {
      reducedMotion = options['reducedMotion'] === true || (await $.env.get('COBALT_REDUCED_MOTION')) === '1'
      const theme = (await $.config.list()).find(row => row.key === 'theme')
      isLight = /light/i.test(String(theme?.value ?? ''))
    })
    // a reload in the middle of a turn: the state says so, the timer is gone
    await quiet(() => scheduleFold($))
    await quiet(async () => {
      if ((await read($, activityAtom)).isWorking) {
        isTurnRunning = true
        startTicker($)
      }
    })
    await ledgerStart($)
    await changeSwarm($, held => configureSwarm(held, { total: config.maxSubagents, sonnet: config.maxSonnet, haiku: config.maxHaiku, opus: isSonnetLed() ? (SONNET_LED_SWARM.opus as number) : 0 }))
    void refreshGit($)
    void refreshMeter($)
    // The NobodyWho watcher: read-only, stat-gated, and started only once the
    // ledger's location is known. Its first read primes at the end of the file,
    // so nothing historical ever reaches the HUD.
    await quiet(() => startLedgerWatch($))
    // How the session is authenticated, read once here and again after a
    // sign-in changes it. The reading is announced the first time and whenever
    // it changes, never on a reload that finds it as it was.
    await quiet(() => probeAuth($, true))
    // Cobalt's own initialization line, shown in the supported AbovePrompt
    // region because Claude Code exposes no startup surface to replace. Each
    // step is appended only as that module really finishes its work, so the
    // line can never claim a step that did not run.
    await quiet(() => markStartup($, 'graph'))
    await quiet(() => markStartup($, 'palette'))
    await quiet(() => markStartup($, 'operator'))
    await quiet(() => markStartup($, 'telemetry'))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await ledgerEnd($)
    stopTicker()
    fieldWalker = RESTING
    // The ledger watcher is cancelled here, so no timer outlives the session.
    stopLedgerWatch()
    band = null
    foldTimer?.cancel()
    foldTimer = null
    gitTimer?.cancel()
    gitTimer = null
    // The router belongs to the session that chose it: whatever follows starts OFF.
    await quiet(() => update($, routerAtom, held => held.mode === 'OFF' ? held : switchRouter(held, 'OFF')))
    if (e.reason === 'clear') {
      // a /clear ends the conversation the task belonged to
      await quiet(() => update($, taskAtom, () => null))
      await quiet(() => update($, activityAtom, () => IDLE))
      await quiet(() => update($, guardsAtom, () => []))
      await quiet(() => update($, visualAtom, () => ({ waiting: 0, agents: [], revision: 0 })))
      await quiet(() => update($, orchestraAtom, () => EMPTY_ORCHESTRA))
    }
    spawning.clear()

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await ledgerPrompt($)
    if (config.isStrict && hasAdvisor) return { drop: 'COBALT STRICT / disable the external advisor before continuing.' }
    // A session already on Fable, or with Fable configured as its advisor, is
    // told so here, before a turn begins; `turn.step` holds the same line for
    // every request this does not see.
    const model = await $.session.model().catch(() => '')
    if (config.blocksFable && (isFable(model) || isAdvisorFable)) {
      await recordBlock($)

      return { drop: `${BLOCK_LINE}. This session is set to use Fable${isAdvisorFable && !isFable(model) ? ' as its advisor' : ''}, which this workflow never runs. Nothing was sent. Switch with /model opus${isAdvisorFable ? ' and turn the advisor off (/advisor)' : ''}.` }
    }
    if (await isApiRefused($).catch(() => false)) return { drop: API_REFUSAL }
    if (!isSupported) return next(e)
    // The init line has done its job the moment real work arrives.
    await dismissStartup($)
    const added: string[] = []
    await quiet(async () => {
      const isPerson = isPersonOrigin(e.origin)
      if (!isPerson) return
      const now = await $.clock.now()
      const sha = (await read($, gitAtom))?.sha ?? null
      const before = await read($, taskAtom)
      const isNewTask = !(before !== null && before.milestones.length > 0 && before.status !== 'done')
      const pin = await read($, discoveryPinAtom)
      let guidance: string | null = null
      // Discovery is read from the full prompt (the stored one is clipped) and only ever goes up; guidance is said once per level.
      const discovered = (t: Task): Task => {
        if (t.milestones.length > 0 && t.discovery === undefined) return t
        const d = withDiscovery(t, pin, { prompt: e.text, files: t.files.map(f => f.path), milestones: t.milestones.length, grounds: [...new Set([...(t.promptGrounds ?? []), ...promptGroundsOf(e.text)])] })
        guidance = guidanceFor(d)

        return guidance === null ? d : markGuided(d)
      }
      const task = await update($, taskAtom, old => {
        // an unfinished planned task goes on; anything else is a new one
        const isContinuing = old !== null && old.milestones.length > 0 && old.status !== 'done'
        // A mandatory review the person or the files raised before any plan is not waived by a later prompt: it goes on
        // with the unplanned task until Opus has answered it. Only a finished task, or an explicit `/cockpit reset`, starts clean.
        const owed = old !== null && !isContinuing && old.status !== 'done' && old.review !== undefined && old.review.state !== 'adjudicated'
        const base = isContinuing ? old : { ...newTask((old?.id ?? 0) + 1, e.text, now, sha), ...(owed ? { review: old.review, ...(old.promptGrounds === undefined ? {} : { promptGrounds: old.promptGrounds }) } : {}) }

        const prompted: Task = {
          ...base,
          lastPrompt: oneLine(e.text, 160),
          updatedAt: now,
          hasInstructionFileRequest: base.hasInstructionFileRequest || namesInstructionFile(e.text),
        }
        if (!isSonnetLed()) return settle(discovered(prompted)).task
        // Grounds are read from the full prompt: the stored one is clipped.
        const promptGrounds = [...new Set([...(prompted.promptGrounds ?? []), ...promptGroundsOf(e.text)])]
        const withGrounds: Task = { ...prompted, promptGrounds }

        return settle(discovered(requireReview(withGrounds, mandatoryGrounds(factsOf(withGrounds, 0, promptGrounds)), promptOrigin(e.text)))).task
      })
      if (task !== null) await mutateLedger($, l => recordDiscovery(l, task, now))
      if (guidance !== null) added.push(guidance)
      if (task !== null && task.milestones.length > 0) added.push(`Cobalt Cockpit, state of the task in progress: ${summaryOf(task)}`)
      // The session router, when one is selected, is asked once at the start of
      // a task and never for a prompt inside one, a tool call or a helper.
      if (isNewTask) {
        const advice = await routeTask($, e.text, { prompt: e.text, files: [], milestones: 0, errorStreak: (await read($, orchestraAtom)).errorStreak, promptGrounds: task?.promptGrounds ?? [] }).catch(() => null)
        if (advice !== null) added.push(advice)
      }
    })

    // A prompt goes on either way: this hook adds what it observed to the
    // context, and a hook that fails would be skipped rather than drop one.
    if (added.length === 0) return next(e)

    return next({ ...e, context: [...(e.context ?? []), ...added] })
  }).catch(async ($, e, next) => {
    // The three drops this hook makes — the strict preset's advisor line, a
    // session set to use Fable, and the subscription policy's — are made here
    // too: forwarding them would send a request the policy exists to refuse.
    if (next.called) return next(e)
    if (config.isStrict && hasAdvisor) return { drop: 'COBALT STRICT / disable the external advisor before continuing.' }
    if (config.blocksFable) {
      const model = await $.session.model().catch(() => '')
      if (isFable(model) || isAdvisorFable) {
        await recordBlock($)

        return { drop: `${BLOCK_LINE}. This session is set to use Fable, which this workflow never runs. Nothing was sent.` }
      }
    }
    if (await isApiRefused($).catch(() => false)) return { drop: API_REFUSAL }

    return next(e)
  })

  on('command.run', { command: 'init' }, async ($, e, next) => {
    // /init is the person asking for a CLAUDE.md
    await quiet(() => change($, task => ({ ...task, hasInstructionFileRequest: true })))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (isSupported) await ledgerTurnStart($, e.turnId)
    if (isSupported) {
      await quiet(async () => {
        const now = await $.clock.now()
        isTurnRunning = true
        await update($, activityAtom, (old): Activity => ({ ...old, kind: 'THINK', detail: '', isWorking: true, toolUseId: null, at: now }))
        startTicker($)
      })
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (isSupported) {
      await quiet(async () => {
        const agentId = e.agentId
        if (agentId !== undefined) {
          sentVia.delete(agentId)
          const now = await $.clock.now()
          await editAgent($, agentId, a => ({ ...a, state: e.reason === 'answer' ? 'done' : 'error', tool: e.reason === 'answer' ? 'Done' : 'Failed', endedAt: now }))
          await scheduleFold($)
          // a subagent finished its own turn: the parent task is exactly where it was
          await update($, activityAtom, old => ({ ...old, agents: old.agents.filter(id => id !== agentId) }))

          return
        }
        const now = await $.clock.now()
        isTurnRunning = false
        stopTicker()
        await update($, activityAtom, (old): Activity => ({ ...old, kind: 'IDLE', detail: '', isWorking: false, toolUseId: null, at: now }))
        // the turn is over; whether the task is done is the milestones' and the gates' to say
        if (e.reason === 'error' || e.reason === 'refusal') {
          await change($, task => noteFailure(task, now, `the turn ended on ${e.reason === 'error' ? 'an API error' : 'a refusal'}`))
        }
        void refreshGit($)
        void refreshMeter($)
      })
    }

    if (isSupported) await ledgerTurnComplete($, e)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // The event is copied because the guards, the effort policy and the
    // read-only shell rewrite may change it; `isChanged` answers whether that
    // copy differs from the event the engine raised.
    const call = { ...e } as typeof e & Record<string, unknown>
    const isChanged = (): boolean =>
      Object.keys(call).length !== Object.keys(e).length ||
      Object.keys(e).some(key => (call as Record<string, unknown>)[key] !== (e as Record<string, unknown>)[key])
    // Fable first, on every engine version and in every loop: a pure check
    // that cannot throw, so no failure below can let the call through.
    if (config.blocksFable && fableRoute(e.tool, call)) {
      await recordBlock($)

      return { deny: BLOCK_DENY }
    }
    if (!isSupported) return next(e)
    const effect = config.hasOrchestration && !e.agentId && !['Read','Grep','Glob','WebFetch','WebSearch','ToolSearch','Agent','Task','TaskOutput','TaskStop','SendMessage',TOOL,SWARM_TOOL_NAME].includes(String(e.tool)) && !(e.tool === 'Bash' && readOnlyShell(String(call['command'] ?? '')))
    if (effect && (spawning.size || commanderEffects.size)) return { deny:'SWARM / commander effect or agent admission in flight; serialize this operation' }
    const effectToken = Symbol(e.tool_use_id)
    if (effect) commanderEffects.add(effectToken)
    try {
    await ledgerToolStart($, call)
    if (String(e.tool) === SWARM_TOOL_NAME) { const r = await serveSwarm($, call); await ledgerToolEnd($, call, r); await raiseAlerts($, false); return r }
    const swarmRefusal = await guardSwarm($, call)
    if (swarmRefusal) { await ledgerToolEnd($, call, { deny: swarmRefusal }); return { deny: swarmRefusal } }
    if (e.tool === TOOL) { const r = await serveProgress($, call as ProgressInput & { agentId?: string }); await ledgerToolEnd($, call, r); await raiseAlerts($, false); return r }

    // a guard that fails must not take every tool call down with it
    const refusal = await guard($, call).catch(() => null)
    if (refusal !== null) { await ledgerToolEnd($, call, refusal); return refusal }

    if (config.hasOrchestration && e.agentId && e.tool === 'Bash' && readOnlyShell(String(call['command'] ?? ''))) (call as Record<string,unknown>)['command'] = String(call['command']).replace(/\bgit\s+(diff|show|log)\b/g, 'git $1 --no-ext-diff --no-textconv').replace(/\bgit\b/g,'git --no-pager')
    // A subagent's reasoning level goes on its own Agent call: the engine's
    // native, per-invocation setting, so nothing global moves under a sibling.
    if (config.hasOrchestration && hasNativeEffort && !e.agentId && e.tool === 'Agent') await quiet(() => launchEffort($, call))
    const beforeWrite = e.tool === 'Write' ? await ledgerBeforeWrite($, call['file_path']) : undefined

    await quiet(() => noteStart($, call))
    // The Activity Field's tape: one entry when a call really starts, closed
    // when it really returns. `callOf` reduces it to safe fields, and a call it
    // does not recognize contributes nothing at all.
    const fieldEvent = callOf(call, await $.clock.now())
    if (fieldEvent !== null) await quiet(() => update($, eventsAtom, log => push(log, fieldEvent)))
    const isQuestion = e.tool === 'AskUserQuestion'
    if (isQuestion) {
      await quiet(() => e.agentId ? editAgent($, e.agentId, a => ({ ...a, state: 'waiting', tool: 'Needs input' })) : update($, visualAtom, old => ({ ...old, waiting: old.waiting + 1 })))
      stopTicker()
    }
    let ran
    try { ran = await next(isChanged() ? call : e) }
    catch (error) { await ledgerToolEnd($, call, { isError: true }); throw error }
    finally {
      if (isQuestion) await quiet(() => e.agentId ? editAgent($, e.agentId, a => ({ ...a, state: 'running', tool: 'Thinking' })) : update($, visualAtom, old => ({ ...old, waiting: Math.max(0, old.waiting - 1) })))
    }
    await ledgerToolEnd($, call, ran, beforeWrite)
    // `SubagentHandback` is the native report channel a bounded helper uses to
    // answer its parent; the host documents it on the Agent result (`handback`)
    // but not in the tool-name union, so it is matched by value, never by name.
    const handbackAgent: string | undefined = typeof e['agentId'] === 'string' ? e['agentId'] : undefined
    if (config.hasOrchestration && handbackAgent !== undefined && (e.tool as string) === 'SubagentHandback' && !ran.deny && !ran.isError && typeof call['message'] === 'string') await quiet(async () => {
      const at = await $.clock.now()
      await changeSwarm($, s => acknowledgeHandback(s, handbackAgent, textOf(call['message']), at))
      await persist($)
    })
    if (e.agentId) await quiet(async () => { const a = (await read($, ledgerAtom)).agents.find(a => a.id === e.agentId); if (a) await editAgent($, e.agentId!, old => ({ ...old, toolCount: a.counts.tools })) })
    await quiet(() => noteEnd($, call, ran))
    // Close the field's entry with the call's real outcome, so the tape can show
    // a break that really happened and never one that did not.
    if (fieldEvent !== null && e.tool_use_id) {
      const finished = await $.clock.now()
      const failed = String((ran as { decision?: string } | undefined)?.decision ?? '') === 'deny'
      await quiet(() => update($, eventsAtom, log => closeOf(log, e.tool_use_id as string, failed, finished)))
    }
    // A task that is plainly under way with no plan is reminded once, beside the
    // edit that showed it (the host's own observation, not the model's word).
    if (e.agentId === undefined && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(e.tool) && 'result' in ran && ran.isError === undefined && ran.deny === undefined) {
      let note: string | null = null
      await quiet(() => update($, taskAtom, t => { const nudged = t === null ? null : progressNudge(t, TOOL); if (nudged === null) return t; note = nudged.note; return nudged.task }))
      if (note !== null) return { ...ran, context: [...(ran.context ?? []), note] }
    }
    // A failure that has repeated is said once, beside the result it repeated
    // on. Every other call returns exactly what the engine answered.
    if (e.agentId === undefined && ran.isError === true) {
      const hint = await repeatedErrorHint($).catch(() => null)
      if (hint !== null) return { ...ran, context: [...(ran.context ?? []), hint] }
    }

    return ran
    } finally { commanderEffects.delete(effectToken) }
  }).catch(($, e, next) => next.called ? next(e) : { deny: `COCKPIT / the tool guard failed, so this call did not run (${next.error.kind}). Do not reach the same effect another way; reload the plugin first.` })

  on('agent.offer', ($, e, next) => {
    // A type whose name identifies Fable is withheld from the listing, and its
    // dispatch is refused with it.
    if (config.blocksFable && isFable(e.agent)) return { isOffered: false }

    return next(e)
  }).catch(($, e, next) => {
    // Judged against the event this handler was given, not refused wholesale: a
    // type whose name identifies Fable is withheld, and every other type goes on.
    if (next.called || !config.blocksFable || !isFable(e.agent)) return next(e)

    return { isOffered: false }
  })

  on('agent.spawn', async ($, e, next) => {
    if (typeof e.permissionMode === 'string') seenPermissionMode = e.permissionMode
    // Refused before the engine resolves a model: a spawn that names Fable, an
    // agent type that does, or a fork of a parent that is on it.
    if (config.blocksFable && (isFable(e.model) || isFable(e.subagentType) || (e.fork && isFable(e.parentModel)))) {
      await recordBlock($)

      return { deny: BLOCK_DENY }
    }
    if (!isSupported) return next(e)
    const role = roleOf(e.subagentType)
    let assignedId = /\[task:([\w.-]+)\]/.exec(e.description)?.[1]
    let reservedId: string | undefined
    // what this spawn's Agent call was launched with, taken once
    const launch = launches.get(e.tool_use_id)
    launches.delete(e.tool_use_id)
    // Reserved before the first await, so the spawns of one message are counted
    // in the order they arrived.
    const token = Symbol(e.tool_use_id)
    const ahead = [...spawning.keys()]
    spawning.set(token, null)
    try {
      if (config.hasOrchestration) {
        if (commanderEffects.size) return { deny:'SWARM / commander effect in flight; assignment remains queued until it completes' }
        const running = await runningAgents($)
        // the spawns ahead of this one that the list does not show yet
        const pending = ahead.filter(one => spawning.has(one) && !running.has(spawning.get(one) ?? '')).length
        const refusal = admitSpawn(running.size + pending, config.maxSubagents)
        if (refusal !== null) {
          await quiet(() => update($, orchestraAtom, old => ({ ...old, refusedLimit: old.refusedLimit + 1 })))

          return { deny: refusal }
        }
        if (role === 'REVIEWER' && !assignedId) {
          const strips = (await read($, visualAtom)).agents
          const task = await read($, taskAtom)
          const verdict = reviewVerdict(await read($, orchestraAtom), {
            task,
            reviewerRunning: strips.some(a => a.role === 'REVIEWER' && a.endedAt === null && running.has(a.id)),
          })
          if (!verdict.ok) {
            await quiet(() => update($, orchestraAtom, old => ({ ...old, refusedReview: old.refusedReview + 1 })))

            return { deny: verdict.reason }
          }
          await update($, orchestraAtom, old => reviewAdmitted(old, verdict.why, task?.id ?? null))
        }
      }
      // A spawn that names no model runs on Sonnet instead of inheriting.
      if (config.hasOrchestration && e.fork) {
        await quiet(() => mutateLedger($, l => warn(l, 'MODEL POLICY / fork refused: forks inherit parent model')))
        return { deny: 'MODEL POLICY / fork inherits its parent model; use an isolated Sonnet agent.' }
      }
      let assigned = swarmState(await read($, ledgerAtom)).tasks.find(t => t.id === assignedId)
      if (config.hasOrchestration) {
        if (e.parentAgentId) return { deny: 'SWARM / only commander delegates; escalate a structured handoff' }
        if (assignedId && !assigned) return { deny: 'SWARM / unknown assignment' }
        const at = await $.clock.now()
        // SONNET_LED: Opus runs only as an admitted consultation. Naming Opus or
        // the architect on an unassigned call is refused, not quietly downgraded.
        if (isSonnetLed() && !assigned && (role === 'ARCHITECT' || tierOf(e.model) === 'OPUS')) return { deny: 'OPUS / NOT ADMITTED. Opus runs only as an admitted consultation: request one with swarm action "consult" (ground and evidence packet), then spawn cobalt-cockpit:architect with the [task:ID] it returns. Nothing was started.' }
        if (!assigned) {
          assignedId = `legacy-${e.tool_use_id}-${(await read($, orchestraAtom)).spawned}`.replace(/[^\w.-]/g,'-')
          const tier = tierOf(e.model) === 'HAIKU' || role === 'SCOUT' || role === 'UTILITY' ? 'HAIKU' : 'SONNET'
          const state = await changeSwarm($, held => submitTask(held, { id: assignedId!, tier, role, objective: textOf(e.description || e.subagentType), mode: ['EXPLORER','RESEARCHER','REVIEWER','SCOUT','UTILITY','ARCHITECT'].includes(role) ? 'read' : 'write', owned:['*'], spawnReason:'Legacy Agent call; unknown scope conservatively exclusive' },at).swarm)
          assigned = state.tasks.find(t => t.id === assignedId)
          if (!assigned) return { deny: 'SWARM / duplicate work suppressed; inspect swarm status' }
        }
        if (assigned.tier === 'OPUS' && !isSonnetLed()) return { deny: 'SWARM / OPUS task stays in commander; no coordinator subagent' }
        if (assigned.tier === 'OPUS') {
          if (!(await read($, ledgerAtom)).consults?.some(c => c.id === assigned!.id)) return { deny: 'OPUS / NOT ADMITTED. An OPUS task runs only as an admitted consultation; request one with swarm action "consult". Nothing was started.' }
          if (role !== 'ARCHITECT') return { deny: 'OPUS / an admitted consultation runs as cobalt-cockpit:architect (read-only) and nothing else. Nothing was started.' }
        } else if (role === 'ARCHITECT' && isSonnetLed()) return { deny: 'OPUS / the architect runs only for an admitted consultation; its task must come from swarm action "consult". Nothing was started.' }
        let admission: ReturnType<typeof admitTask> | undefined
        await changeSwarm($, held => { admission = admitTask(held,assignedId!,at); return admission.swarm })
        if (!admission!.ok) return { deny: `SWARM / queued ${assignedId}: ${admission!.reason}; retry after dependency/ownership/resource clears` }
        reservedId = assignedId
      }
      const model = config.hasOrchestration ? (assigned?.tier === 'HAIKU' ? HAIKU_MODEL : assigned?.tier === 'OPUS' && isSonnetLed() ? OPUS_MODEL : AGENT_MODEL) : e.model
      const originLedger = await read($, ledgerAtom)
      const spawnAt = await $.clock.now()
      // The launch level is on the task before the subagent exists: its first
      // request can arrive before the spawn below has returned and bound it.
      if (reservedId) await changeSwarm($, held => setLaunchEffort(held, reservedId!, launch?.level ?? null, launch?.named ?? null))
      const spawned = model === undefined || model === e.model
        ? await next(e)
        : await next({ ...e, model })
      if (reservedId && spawned.agentId) await changeSwarm($, held => bindAgent(held,reservedId!,spawned.agentId!,spawnAt))
      else if (reservedId) await changeSwarm($, held => setLaunchEffort(releaseReservation(held,reservedId!,spawnAt,spawned.deny ?? 'Host did not report agent ID'), reservedId!, null))
      await quiet(() => ledgerSpawn($, e, spawned, originLedger, spawnAt))
      if (reservedId && spawned.agentId) await mutateLedger($, l => { const done = l.observedCompletions?.find(c=>c.agentId===spawned.agentId); return done ? { ...finishTurn(l,{ turnId:l.turns[spawned.agentId!] ?? UNKNOWN,agentId:spawned.agentId!,reason:done.reason },done.at), swarm:finishObserved(swarmState(l),reservedId!,done.reason,done.conclusion,done.at) } : l })
      if (spawned.agentId) {
        spawning.set(token, spawned.agentId)
        await quiet(async () => {
          const now = await $.clock.now()
          const seq = (await update($, orchestraAtom, old => ({ ...old, spawned: old.spawned + 1 }))).spawned
          const ledgerAgent = (await read($, ledgerAtom)).agents.find(a => a.id === spawned.agentId)
          const agent: AgentStrip = { parentRun: ledgerAgent?.runId, originTurn: ledgerAgent?.originTurn, toolCount: 0, id: spawned.agentId!, title: oneLine(e.description || e.subagentType, 60), model: spawned.model ?? null, effort: null, tool: ledgerAgent?.status === 'success' ? 'Done' : ledgerAgent && ledgerAgent.status !== 'running' ? 'Failed' : 'Starting', state: ledgerAgent?.status === 'success' ? 'done' : ledgerAgent && ledgerAgent.status !== 'running' ? 'error' : 'running', startedAt: now, endedAt: typeof ledgerAgent?.end === 'number' ? ledgerAgent.end : null, role: assigned?.role ?? role, seq }
          await update($, visualAtom, old => ({ ...old, agents: [...old.agents.filter(a => a.id !== agent.id), agent].filter((a,i,all)=>a.endedAt === null || i >= all.length - 32) }))
        })
      }

      return spawned
    } catch (error) {
      if (reservedId) { const at = await $.clock.now(); await changeSwarm($, held => { const t = held.tasks.find(t=>t.id===reservedId); return t?.state === 'reserved' && !t.agentId ? setLaunchEffort(releaseReservation(held,reservedId!,at,'Host spawn failed'), reservedId!, null) : held }) }
      throw error
    } finally {
      spawning.delete(token)
    }
  }).catch(($, e, next) => next.called ? next(e) : { deny: 'COCKPIT / the agent-admission guard failed, so no subagent started. Nothing was sent; reload the plugin before retrying.' })

  on('turn.step', async function* ($, e, next) {
    // The one place every model request passes, main's and a subagent's, with
    // the model the engine resolved for it (the session's, an alias's target, a
    // fallback's). Answering without `next` sends nothing, so a request that
    // names Fable, or would carry Fable as its advisor, is never made: the
    // refusal is the response, and there is no request to reject afterward.
    if (config.blocksFable && (isFable(e.model) || isAdvisorFable)) {
      await recordBlock($)
      yield { kind: 'text', index: 0, text: BLOCK_LINE }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }

      return { turnId: e.turnId, index: e.index, answer: BLOCK_LINE, toolUses: [], stopReason: 'end_turn', usage: null }
    }
    // The same for a session that is not on the subscription.
    if (await isApiRefused($).catch(() => false)) {
      const text = 'AUTH / API DETECTED'
      yield { kind: 'text', index: 0, text }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }

      return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
    }
    if (config.isStrict && hasAdvisor) return { turnId: e.turnId, index: e.index, answer: 'COBALT STRICT / external advisor disabled.', toolUses: [], stopReason: 'end_turn', usage: null }
    // Every reading below is quiet: a hook that fails before `next` is skipped,
    // which for this one would send a request the policy exists to refuse.
    const agentId = e.agentId
    const task = agentId === undefined ? undefined : await quietly(() => taskOfAgent($, agentId))
    if (config.hasOrchestration && task?.cancellationRequested) {
      const text = 'SWARM / cancellation requested'
      yield { kind: 'text', index: 0, text }; yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index:e.index, answer:text, toolUses:[], stopReason:'end_turn', usage:null }
    }
    if (task && config.hasOrchestration) {
      const id = task.id
      await quiet(async () => { const at = await $.clock.now(); await changeSwarm($, held => heartbeat(held,id,at)) })
    }
    // The tier is the policy's. OPUS_LED: Opus commands, Sonnet engineers, Haiku
    // scouts. SONNET_LED: Sonnet leads and builds, Haiku scouts, and Opus runs
    // only as an admitted consultation's subagent. The model id follows from the
    // tier; the effort below is resolved separately, so two agents side by side
    // can run at different levels without a global move.
    const tier: ModelTier = !e.agentId ? (isSonnetLed() ? 'SONNET' : 'OPUS') : (task?.tier ?? (tierOf(e.model) === 'HAIKU' ? 'HAIKU' : 'SONNET'))
    const subTier: SubagentTier = tier === 'HAIKU' ? 'HAIKU' : tier === 'OPUS' && e.agentId !== undefined && isSonnetLed() ? 'OPUS' : 'SONNET'
    const wanted = desiredRequest(e.agentId, subTier, config.profile)
    const isMain = e.agentId === undefined
    let constrained = e
    let mismatch: string | null = null
    let resolution: EffortResolution | null = null
    // The level this loop's Agent call was launched with, when one was set
    // natively. The engine has then already resolved the request's effort from
    // it, under its own caps and overrides: that level is read, not rewritten.
    const launched = config.hasOrchestration && isEffortLevel(task?.launchEffort) ? task.launchEffort : null
    let hostReason: string | null = null
    if (config.hasOrchestration && isMain) {
      // The profile's model leads; how hard it thinks is the person's to say. A rewrite here
      // would outrank `/effort`, `--effort`, the settings and the variable
      // alike, so the main loop's effort is left exactly as the engine resolved it.
      constrained = { ...e, model: wanted.model }
      mismatch = policyMismatch(e.model, e.effort, e.agentId, subTier, config.profile)
    } else if (config.hasOrchestration) {
      const facts: EffortFacts = { tier, ...(task ? factsFromRole(task.role, task.mode) : {}) }
      // An explicit level on the task is the commander's, and wins; otherwise
      // AUTO names one from the task and MANUAL honours the fixed tier level.
      const named = task !== undefined && task.requestedEffort !== 'AUTO' ? task.requestedEffort : null
      const known = await quietly(() => read($, effortKnownAtom))
      const capability = capabilityOf(wanted.model, known ?? {})
      const manual = config.reasoningMode === 'MANUAL' && named === null
      // A subagent no task is known for yet, on an engine that takes the level
      // on the Agent call: its request already carries what it was launched
      // with, and the tier's baseline must not be written over that.
      const isUnknown = hasNativeEffort && task === undefined
      if (isUnknown || (manual && !isEffortLevel(wanted.effort))) {
        // MANUAL names no level for this tier (Haiku): leave the engine's own in place.
        constrained = { ...e, model: wanted.model }
      } else {
        const requested: EffortRequest = manual ? wanted.effort as EffortLevel : named ?? 'AUTO'
        resolution = chooseEffort(requested, facts, capability, config.maxEffort)
        constrained = launched !== null ? { ...e, model: wanted.model } : { ...e, model: wanted.model, ...(resolution.applied === undefined ? {} : { effort: resolution.applied }) }
        if (launched !== null) hostReason = launchFallback(resolution, launched, e.effort, wanted.model)
      }
      // a natively launched loop's level is judged against its launch above, not against the fixed tier level
      mismatch = policyMismatch(e.model, launched === null && !isUnknown ? e.effort : wanted.effort, e.agentId, subTier, config.profile)
      const applied = launched !== null ? (e.effort === undefined ? null : String(e.effort)) : resolution?.applied
      // The engine's own resolution of a level this plugin launched with is a
      // real observation: learned from, and said aloud when it differs.
      if (task && applied !== undefined && task.appliedEffort !== applied) {
        await quiet(() => changeSwarm($, held => setAppliedEffort(held, task.id, applied)))
        if (launched !== null && isEffortLevel(e.effort)) { const level = e.effort; await quiet(() => update($, effortKnownAtom, known => observeCapability(known, wanted.model, launched, level))) }
      }
      if (launched !== null && e.effort !== launched) {
        const said = `EFFORT FALLBACK / engine applied ${applied ?? 'no effort'}; requested ${launched}`
        await quiet(() => mutateLedger($, l => l.warnings.includes(said) ? l : warn(l, said)))
      }
    }
    // The main loop's level is the host's, with what can be seen of where it
    // came from. A request moved to another model is resolved again by the
    // engine for that model, so the level it arrived with says nothing certain.
    const host = isMain ? hostEffort(e.effort, await hostSignals($, e.turnId, e.model)) : null
    const isMoved = isMain && constrained.model !== e.model
    const mainReason = host === null ? undefined : isMoved ? `host-resolved ${e.effort === undefined ? 'no effort' : String(e.effort)} for ${e.model}; moved to ${constrained.model}, which the engine resolves again` : host.reason
    if (host !== null && host.selected !== null && host.selected !== e.effort) {
      const said = `EFFORT FALLBACK / engine applied ${String(e.effort)}; requested ${host.selected}`
      await quiet(() => mutateLedger($, l => l.warnings.includes(said) ? l : warn(l, said)))
    }
    // Who put the effort on this request: the engine, or this hook's rewrite.
    const via = constrained.effort === e.effort && !isMoved ? 'host' as const : 'hook' as const
    sentVia.set(e.agentId ?? 'main', via)
    if (e.agentId) await quiet(() => editAgent($, e.agentId!, a => ({ ...a, model: constrained.model, effort: constrained.effort === undefined ? null : String(constrained.effort) })))
    // the main loop's effort, as the engine resolved it for this request
    else if (isSupported) await quiet(() => setMeter($, { model: constrained.model, effort: e.effort === undefined ? null : String(e.effort), reasoningMode: config.reasoningMode, effortSource: e.effort === undefined ? null : 'engine', requestedEffort: host?.selected ?? (e.effort === undefined ? null : String(e.effort)), effortReason: mainReason ?? null, hostSource: host?.source ?? null }))
    const result = yield* next(constrained)
    const asked = host !== null ? { ...e, effort: host.selected ?? e.effort } : resolution === null ? e : { ...e, effort: resolution.selected }
    await quiet(() => ledgerRequest($, asked, { model: constrained.model, effort: constrained.effort, usage: result.usage, routingReason: host !== null ? mainReason : resolution?.reason, fallbackReason: host !== null ? host.capReason : launched === null ? resolution?.fallbackReason : hostReason, via }, mismatch))
    if (result.usage && result.usage.model !== constrained.model) await quiet(() => mutateLedger($, l => warn(l, `MODEL POLICY / response mismatch: ${result.usage!.model}`)))
    // What answered is read off the response itself. With the refusal above it
    // is never Fable; if it ever were, the count says so.
    const answeredBy = result.usage?.model
    if (isFable(answeredBy)) await quiet(() => update($, policyAtom, old => answered(old, answeredBy)))

    return result
  })

  on('config.set', async ($, e, next) => {
    // A config row that chooses a model (the session's, the advisor's, a
    // fallback's) is not set to Fable. The rows that deny models are left alone.
    if (config.isStrict && /advisor/i.test(e.key) && e.value) return { deny: 'COBALT STRICT / external advisor disabled.' }
    const names = typeof e.value === 'string' ? [e.value] : Array.isArray(e.value) ? e.value : []
    if (config.blocksFable && /model|advisor/i.test(e.key) && !/denied|blocked/i.test(e.key) && names.some(isFable)) {
      await recordBlock($)

      return { deny: BLOCK_LINE }
    }

    return next(e)
  }).catch(($, e, next) => {
    // The row this handler was given is judged by the rule this hook holds, so
    // an ordinary row is written and only the rows it would have refused are not.
    if (next.called) return next(e)
    const names = typeof e.value === 'string' ? [e.value] : Array.isArray(e.value) ? e.value : []
    if (config.blocksFable && /model|advisor/i.test(e.key) && !/denied|blocked/i.test(e.key) && names.some(isFable)) return { deny: 'COBALT / the model-configuration guard failed, so the row was left as it was.' }
    if (config.isStrict && /advisor/i.test(e.key) && e.value) return { deny: 'COBALT STRICT / the advisor guard failed, so the row was left as it was.' }

    return next(e)
  })

  on('command.run', { command: 'model' }, async ($, e, next) => {
    const refused = await guardModelCommand($, e.args)
    if (refused !== null) return refused

    return next(e)
  }).catch(($, e, next) => {
    // Only a command line that names Fable is refused; anything else runs.
    if (next.called || !config.blocksFable || !e.args.split(/[\s=,]+/).some(isFable)) return next(e)

    return { text: `${BLOCK_LINE}. The model guard failed, so nothing was changed.` }
  })

  on('command.run', { command: 'effort' }, async ($, e, next) => {
    // The person's own choice for the session, and all of it a plugin can see:
    // the level as typed. It is only noted, to name where the main loop's level
    // came from; the command runs as it was given. A choice made in the picker
    // (no argument) is not visible, and nothing is noted for it.
    const ran = await next(e)
    const typed = e.args.trim().split(/\s+/)[0] ?? ''
    effortCommand = typed === '' ? null : typed.toLowerCase()
    hostSignalsAt = null

    return ran
  }).catch(($, e, next) => {
    // It only notes what was typed: the command runs either way.
    return next(e)
  })

  on('command.run', { command: 'advisor' }, async ($, e, next) => {
    if (config.isStrict && e.args.trim() && !/^(off|none|disable)$/i.test(e.args.trim())) return { text: 'COBALT STRICT / external advisor disabled.' }
    const refusal = await guardModelCommand($, e.args)
    if (refusal !== null) return refusal
    const ran = await next(e)
    // the picker may have changed the advisor: read the settings again
    await quiet(() => probeAuth($, true))

    return ran
  }).catch(($, e, next) => {
    // The two refusals this hook makes, judged on the command it was given: a
    // line that names Fable, and the strict preset's advisor change.
    if (next.called) return next(e)
    if (config.blocksFable && e.args.split(/[\s=,]+/).some(isFable)) return { text: `${BLOCK_LINE}. The advisor guard failed, so nothing was changed.` }
    if (!config.isStrict || e.args.trim() === '' || /^(off|none|disable)$/i.test(e.args.trim())) return next(e)

    return { text: 'COBALT STRICT / the advisor guard failed, so nothing was changed.' }
  })

  on('command.run', { command: 'login' }, async ($, e, next) => {
    const ran = await next(e)
    await quiet(() => probeAuth($, true))

    return ran
  }).catch(($, e, next) => {
    // It only re-reads the authentication: the command runs either way.
    return next(e)
  })

  on('command.run', { command: 'logout' }, async ($, e, next) => {
    const ran = await next(e)
    await quiet(() => probeAuth($, true))

    return ran
  }).catch(($, e, next) => {
    // It only re-reads the authentication: the command runs either way.
    return next(e)
  })

  on('classic.PostToolUse', async ($, e, next) => {
    // The engine reports the level its own settings resolve for the loop. A
    // level this plugin rewrote onto the request in `turn.step` is not in that
    // report, so for such a loop it is neither recorded as applied, nor warned
    // about as a downgrade, nor learned from: it says nothing about the request.
    let via = sentVia.get(e.agent_id ?? 'main')
    if (isSupported && via === undefined) await quiet(async () => {
      const before = await read($, ledgerAtom)
      via = e.agent_id === undefined ? before.runs.find(r => r.id === before.currentRun)?.effortVia : before.agents.find(a => a.id === e.agent_id)?.effortVia
    })
    const level = via === 'hook' ? undefined : e.effort?.level
    if (isSupported) await quiet(async () => {
      await mutateLedger($, l => classicTelemetry(l, e, via))
      if (level !== undefined) {
        // What the engine really applied this turn, next to what this request
        // asked for: when they differ the request was downgraded, and the fact
        // is recorded and folded into the model's observed capability.
        const held = await read($, ledgerAtom)
        const agent = e.agent_id === undefined ? undefined : held.agents.find(a => a.id === e.agent_id)
        const run = held.runs.find(r => r.id === held.currentRun)
        // `classicTelemetry` has already replaced `effort` with the engine's
        // applied level, so the comparison this warning exists for must be made
        // against what this plugin *requested* (`requestedEffort`), not against
        // the value that was just overwritten. Otherwise `expected` would always
        // equal `level` and neither the fallback nor the observation could fire.
        const expected = e.agent_id === undefined ? run?.requestedEffort : agent?.requestedEffort
        const observed = e.agent_id === undefined ? run?.model : agent?.model
        if (agent !== undefined) await editAgent($, e.agent_id!, a => ({ ...a, effort: level }))
        if (expected !== undefined && expected !== UNKNOWN && expected !== level) await mutateLedger($, l => warn(l, `EFFORT FALLBACK / engine applied ${level}; requested ${expected}`))
        // The main loop's requested level is the person's own selection: a lower
        // applied level there is a cap of the host's, not something the model cannot do.
        if (observed !== undefined && observed !== UNKNOWN && isEffortLevel(expected) && isEffortLevel(level) && (e.agent_id !== undefined || expected === level)) await update($, effortKnownAtom, known => observeCapability(known, observed, expected, level))
      }
      await persist($)
    })
    if (isSupported && e.agent_id === undefined && level !== undefined && level !== lastEffort) {
      lastEffort = level
      await quiet(() => setMeter($, { effort: level }))
    }

    return next(e)
  }).catch(($, e, next) => {
    // A reading of what the engine reported, not a gate: the tool call already
    // ran, and nothing about it is undone here.
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (isSupported) await ledgerMeasure($)
    if (isSupported) {
      await quiet(() =>
        setMeter($, { percent: e.context.percent ?? null, tokens: e.context.tokens ?? null, window: e.context.window }),
      )
    }

    return next(e)
  })

  on('attribution.text', async ($, e, next) => {
    // the trailer and footer the engine would have Claude write into commits and PRs
    if (config.hasAttributionGuard && (e.kind === 'commit' || e.kind === 'pr')) return { text: '' }

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!isSupported || e.traits.includes('bare')) return composed
    const text = `${DISCIPLINE}${config.hasAttributionGuard ? HYGIENE : ''}${config.hasGuard ? SAFETY : ''}${config.hasOrchestration ? orchestrationText(config.maxSubagents, config.profile) + effortPolicyText(config.reasoningMode, config.maxEffort, config.profile) : ''}${config.blocksFable ? `\n\n${FABLE_RULE}` : ''}`

    return { sections: [...composed.sections, { id: 'cobalt-cockpit:discipline', text, scope: 'session' }] }
  })

  on('command.run', { command: 'cockpit' }, async ($, e) => {
    const [verb = '', value = ''] = e.args.trim().toLowerCase().split(/\s+/)
    const savePrefs = async (patch: Partial<Prefs>): Promise<Prefs> => {
      const prefs = await update($, prefsAtom, old => ({ ...old, ...patch }))
      await quiet(() => $.store.set('prefs', prefs))

      return prefs
    }
    switch (verb) {
      case '':
      case 'open': {
        const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
        if (isOpen && verb === '') {
          await $.ui.close({ id: PANE })

          return {}
        }
        const opened = await $.ui.open({ id: PANE, title: `${OPERATOR} // Mission Control` })

        return opened.isPlaced ? {} : { text: `Cockpit is waiting to be placed: ${opened.reason}` }
      }
      case 'close':
        await $.ui.close({ id: PANE })

        return {}
      case 'status':
        return { text: summaryOf(await read($, taskAtom)) }
      case 'reset':
        // Clearing the task also clears a held mandatory review, so it is the person's alone: a command another plugin ran,
        // a trigger, a peer or an origin this build does not know is refused, and nothing is changed.
        if (!isPersonOrigin(e.origin)) return { text: 'Cockpit: the task is cleared only by a command you type; nothing was changed.' }
        await update($, taskAtom, () => null)

        return { text: 'Cockpit: task cleared.' }
      case 'mute':
      case 'unmute':
        await savePrefs({ isMuted: verb === 'mute' })

        return { text: verb === 'mute' ? 'Cockpit: cues muted.' : 'Cockpit: cues on.' }
      case 'hud': {
        const held = await read($, prefsAtom)
        const isHudHidden = value === 'off' ? true : value === 'on' ? false : !held.isHudHidden
        await savePrefs({ isHudHidden })

        return { text: isHudHidden ? 'Cockpit: HUD hidden.' : 'Cockpit: HUD shown.' }
      }
      case 'discovery': {
        const pinned = value === '' ? undefined : value === 'auto' ? null : (['light', 'standard', 'deep'].includes(value) ? value.toUpperCase() as DiscoveryLevel : undefined)
        const isPerson = isPersonOrigin(e.origin)
        if (value !== '' && pinned === undefined) return { text: `Cockpit: "${value}" is not a level. Use /cockpit discovery light | standard | deep | auto.` }
        // Only the person pins a level; a command another plugin ran may look.
        if (pinned !== undefined && !isPerson) return { text: 'Cockpit: the discovery level is pinned only by a command you type; nothing was changed.' }
        if (pinned !== undefined) {
          await update($, discoveryPinAtom, () => pinned)
          await change($, task => pinned === null ? unpin(task) : withDiscovery(task, pinned))
        }
        const columns = (e as { presentation?: { columns?: number } }).presentation?.columns
        const task = await read($, taskAtom)
        const pin = await read($, discoveryPinAtom)

        return { text: [...discoveryRows(task, columns ?? 72), `PIN / ${pin ?? 'none (rules decide)'}${value === '' ? ' · /cockpit discovery light | standard | deep | auto (this session only; LIGHT also waives the goal check; gates and consultations are unchanged)' : ''}`].join('\n') }
      }
      case 'router': {
        const held = await read($, routerAtom)
        let target = value === '' ? null : routerModeOf(value)
        // Only the person switches a router: a command another plugin or a trigger ran may look, not choose.
        const isPerson = isPersonOrigin(e.origin)
        if (target !== null && target !== held.mode && !isPerson) return { text: `ROUTER / ${routerLine(held)}\nCockpit: the router is switched only by a command you type; nothing was changed.` }
        if (value !== '' && target === null) return { text: `Cockpit: "${value}" is not a router. Use /cockpit router off | nobodywho | jev.\nROUTER / ${routerLine(held)}` }
        // no word given: the engine's own dialog, where there is someone to ask
        if (target === null && isPerson) target = await pickRouter($, held.mode)
        if (target === null) return { text: `ROUTER / ${routerLine(held)}\nSwitch with /cockpit router off | nobodywho | jev. The choice lasts for this session; a new session starts OFF.` }
        if (target === held.mode) return { text: `ROUTER / ${routerLine(held)} (unchanged)` }

        return { text: await selectRouter($, target) }
      }
      case 'stats': {
        // read-only; it makes no model call and touches nothing but the local telemetry files
        const words = e.args.trim().toLowerCase().split(/\s+/).slice(1)
        const format = words.includes('--json') ? 'json' : words.includes('--csv') ? 'csv' : 'text'
        const win = parseWindow(words.find(w => !w.startsWith('--')) ?? '30d')
        const strays = words.filter(w => w.startsWith('--') && w !== '--json' && w !== '--csv')
        if (win === null || strays.length > 0 || (words.includes('--json') && words.includes('--csv'))) return { text: 'Cockpit: usage /cockpit stats 7d | 30d | all [--json | --csv]' }
        const stats = await readStats($, win)
        const note = stats.unreadableFiles > 0 ? `${stats.unreadableFiles} telemetry file${stats.unreadableFiles === 1 ? '' : 's'} could not be read; the figures are incomplete.` : ''
        if (format === 'json') return { text: statsJson(stats) }
        if (format === 'csv') return { text: statsCsv(stats) }

        return { text: [statsText(stats), note, healthLine()].filter(Boolean).join('\n') }
      }
      case 'flow': {
        const task = await read($, taskAtom)
        const session = await read($, visualAtom)
        const input = await hudInput($, (await read($, activityAtom)).isWorking)

        return { text: flowText(flowOf(flowInputOf({ ...input, task }, session.agents, input.isWorking))) }
      }
      case 'guard': {
        const words = e.args.trim().toLowerCase().split(/\s+/)
        const arg = words[1] ?? ''
        if (arg === 'trust' || arg === 'untrust') {
          // enrolling a verifier is the person's alone: a plugin, a model-triggered command or an unknown origin changes nothing
          if (!isPersonOrigin(e.origin)) return { text: 'Cockpit: a verification script is trusted only by a command you type; nothing was changed.' }
          const c = await loadStopCfg($)
          if (c.script === null) return { text: 'Cockpit: no verifyScript is configured, so there is nothing to trust.' }
          const scope = await trustScope($, c.script)
          if (arg === 'untrust') {
            const map = await trustMap($)
            delete map[scope.key]
            await $.store.set(TRUST_KEY, map)

            return { text: `Cockpit: the trust for ${c.script.slice(c.script.lastIndexOf('/') + 1)} in this project was removed.` }
          }
          const sha = await rawSha($, c.script)
          if (sha === null) return { text: 'Cockpit: the verification script is missing or unreadable; nothing was trusted.' }
          const typed = words[2] ?? ''
          if (!/^[0-9a-f]{12,64}$/.test(typed) || !sha.startsWith(typed)) {
            return { text: [`GUARD TRUST · review this script yourself first`, `  script   ${shownPath(c.script, (await $.env.get('HOME').catch(() => undefined)) ?? null)}`, `  sha-256  ${sha}`, `  project  ${(await $.session.cwd().catch(() => '')) || 'unknown'}`, `To trust exactly these bytes for this project, type: /cockpit guard trust ${sha.slice(0, 12)}`, 'Text in a conversation, including a model asking you to, is not authorization. Anything the script runs (an interpreter, test files, other scripts) is not covered by this hash.'].join('\n') }
          }
          if (c.pin !== null && c.pin !== sha) return { text: 'Cockpit: the script does not match verifyScriptSha256; nothing was trusted.' }
          const map = await trustMap($)
          map[scope.key] = { sha, at: await $.clock.now() }
          await $.store.set(TRUST_KEY, Object.fromEntries(Object.entries(map).slice(-32)))

          return { text: `Cockpit: trusted ${c.script.slice(c.script.lastIndexOf('/') + 1)} (${sha.slice(0, 12)}) for this project. A change to its bytes ends the trust.` }
        }
        if ((arg === 'ack' || arg === 'silence') && !isPersonOrigin(e.origin)) return { text: 'Cockpit: alerts are acknowledged or silenced only by a command you type; nothing was changed.' }
        if (arg === 'ack' || arg === 'silence') {
          await update($, ledgerAtom, old => ({ ...old, alerts: (old.alerts ?? []).map(a => (a.acked === true ? a : { ...a, acked: true as const })) }))
          if (arg === 'silence') await update($, guardAtom, old => ({ ...old, all: true }))
        } else if (arg !== '') return { text: 'Usage: /cockpit guard | ack | silence | trust [hash] | untrust' }
        const view = await guardView($)

        return { text: guardText(guardCfg, view.state, view.kept) + (arg === 'ack' || arg === 'silence' ? '\nThe verification verdict was not changed.' : '') }
      }
      case 'doctor':
        return { text: doctorText(await doctorFacts($)) }
      case 'version':
      case 'source': {
        // What is really loaded, and where from: the manifest on disk, not a
        // version this module remembers. A stale install and a live source tree
        // are told apart by the path, which is the failure this diagnostic exists
        // for. The observed effort capability is printed only when one was seen.
        let version: string = UNKNOWN
        try { version = /"version"\s*:\s*"([^"]+)"/.exec(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))?.[1] ?? UNKNOWN } catch { /* manifest unreadable: version stays unknown */ }
        const observed = Object.entries(await read($, effortKnownAtom))
        const model = await $.session.model().catch(() => '')
        const meter = await read($, meterAtom)
        // What AUTO would name for the commander is advice only, and only when
        // no selection of the person's was seen: the level stays the host's.
        const advised = config.hasOrchestration && config.reasoningMode === 'AUTO' && meter.hostSource === 'host'
          ? chooseEffort('AUTO', { tier: isSonnetLed() ? 'SONNET' : 'OPUS' }, capabilityOf(isSonnetLed() ? AGENT_MODEL : MAIN_MODEL, Object.fromEntries(observed)), config.maxEffort).applied
          : undefined

        return {
          text: [
            `PLUGIN / ${$.plugin.name} ${version}`,
            `SOURCE / ${$.plugin.root}`,
            `SESSION MODEL / ${model === '' ? UNKNOWN : model}`,
            ...(config.hasOrchestration ? [`PROFILE / ${config.profile}${isSonnetLed() ? ` · main ${AGENT_MODEL} · Opus on admission · budget ${config.maxSubagents} (Sonnet ${String(config.maxSonnet)} · Haiku ${String(config.maxHaiku)} · Opus 1)` : ` · main ${MAIN_MODEL}`}`] : []),
            `ROUTER / ${routerLine(await read($, routerAtom))}`,
            `REASONING / ${config.reasoningMode} · ceiling ${config.maxEffort.toUpperCase()}`,
            // the main loop's level is the host's: read, with what was seen of its origin
            `MAIN EFFORT / host-resolved, never rewritten${meter.effort ? ` · ${meter.effort}${meter.hostSource ? ` (${meter.hostSource})` : ''}` : ''}${advised !== undefined && meter.effort && advised !== meter.effort ? ` · AUTO would name ${advised}: /effort ${advised} to set it` : ''}`,
            // how a subagent's level reaches the engine, and whether the engine's reports can confirm it
            ...(config.hasOrchestration ? [`SUBAGENT EFFORT / ${hasNativeEffort ? 'set on the Agent call · engine-resolved level recorded' : 'turn.step rewrite · the engine does not report it back'}`] : []),
            ...(observed.length ? [`OBSERVED EFFORT / ${observed.map(([id, levels]) => `${id} ${[...levels].join('/')}`).join(' · ')}`] : []),
          ].join('\n'),
        }
      }
      case 'auth': {
        await quiet(() => probeAuth($, false))
        const auth = await read($, authAtom)
        const policy = await read($, policyAtom)

        return {
          text: [
            ...(auth === null ? ['AUTH / NOT READ'] : authLines(auth, config.blocksFable)),
            ...(auth?.mode === 'api' ? [...(auth.credential === 'api-key' ? ['SOURCE / engine holds an API key'] : []), ...auth.sources.map(source => `SOURCE / ${source}`)] : []),
            `FABLE CALLS / ${policy.calls}`,
            ...(policy.blocks > 0 ? [`FABLE REFUSED / ${policy.blocks}`] : []),
          ].join('\n'),
        }
      }
      case 'sound': {
        if (!config.hasSounds) return { text: 'Cockpit: sounds are off in the plugin configuration.' }
        if ((await read($, prefsAtom)).isMuted) return { text: 'Cockpit: cues are muted (/cockpit unmute).' }
        const first = await sound($, 'checkpoint')
        await $.clock.sleep(350).catch(() => undefined)
        await sound($, 'complete')

        return { text: first === null ? 'Cockpit: no audio player answered; cues are silent.' : `Cockpit: played both cues with ${first}.` }
      }
      default:
        return { text: HELP }
    }
  }).catch(($, e, next) => next.called ? next(e) : { text: 'Cobalt: the cockpit command could not be read; nothing was changed.' })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!isSupported || !config.hasHud || e.props.hasSurvey || (await read($, prefsAtom)).isHudHidden || e.props.maxRows < 1) {
      band = null
      stopTicker()
      return next(e)
    }
    const input = await hudInput($, e.props.isWorking)
    const session = await read($, visualAtom)
    const now = await $.clock.now()
    const v = visualOf(input, session.waiting > 0 || (await read($, guardsAtom)).length > 0)
    const motion = config.isAnimated && !reducedMotion
    const layout = layoutOf(e.props.bodyColumns, v.percentText)
    const id = `${input.task?.id ?? 0}/${input.task?.lifecycle ?? 0}`
    const glide = transition(head?.id === id ? head.glide : null, v.percent / 100, now, motion && v.active)
    head = { id, glide }
    const { Box, Text } = $.ui.resolve(e)
    const t = $.ui.resolve(e)
    const Raster = 'Raster' in t ? t.Raster : null
    const Svg = 'Svg' in t ? t.Svg : null
    // The Neural Flow takes one row, paid for out of the strips' rows like the orchestration line; it is not drawn when the band is short.
    const flowInput = flowInputOf(input, session.agents, e.props.isWorking)
    const flowWidth = e.props.bodyColumns
    const flowWanted = config.hasFlow && input.task !== null && e.props.maxRows >= 4 && flowLayout(flowWidth) !== null
    const room = Math.max(0, e.props.maxRows - 1 - (layout.columns >= 44 ? 1 : 0) - (flowWanted ? 1 : 0))
    // The orchestration line sits above the strips and is paid for out of their
    // rows, so the band is never taller for it; with one row to spare the strips
    // keep it and the line is left out.
    const crew = visibleAgents(session.agents, now, session.agents.length).shown
    const hasCrew = config.hasOrchestration && room >= 2 && crew.some(hasRole)
    const stripRoom = hasCrew ? room - 1 : room
    let agents = visibleAgents(session.agents, now, Math.min(3, stripRoom))
    if (agents.folded && stripRoom > 1) agents = visibleAgents(session.agents, now, Math.min(2, stripRoom - 1))
    const crewView: OrchestraView = { meter: input.meter, task: input.task, activity: input.activity, isWorking: e.props.isWorking, agents: crew, nwho: null, limit: config.maxSubagents, now, ...(isSonnetLed() ? { profile: 'SONNET_LED' as const } : {}) }
    const crewLine = hasCrew && agents.shown.length > 0 ? headerText(crewView, layout.columns) : ''
    // API-style authentication is the one diagnostic that stays on screen: it
    // is a warning, and it is only ever there when it is true.
    const auth = await read($, authAtom)
    const authWarning = auth?.mode === 'api' && layout.columns >= 20 ? fitText('AUTH / API DETECTED', layout.columns) : ''
    // VECTOR, in whichever form this surface can carry: a portrait where SVG
    // exists, three cells of visor on a terminal, one glyph in a narrow band.
    // The badge is static per state, so it never enters the blit loop.
    let badge: RenderElement | null = null
    if (layout.badgeWidth >= 3) {
      if (e.surface === 'terminal' && Raster) badge = <Raster key="operator" columns={3} rows={1} cells={mascotGrid(v.state).encode()} />
      else if (Svg) badge = <Svg key="operator" source={mascotSvg(v.state, motion)} alt={mascotAlt(v.state)} width={PANEL_W} height={PANEL_H} />
      else badge = <Text key="operator" color={STATE_COLOR[v.state]} bold>{MICRO[v.state]}</Text>
    } else if (layout.badgeWidth === 1) {
      badge = <Text key="operator" color={STATE_COLOR[v.state]} bold>{MICRO[v.state]}</Text>
    }
    // one column of air between the operator and whatever sits beside it
    const gutter = badge === null ? null : <Text> </Text>
    const title = fitText(input.task?.goal || input.git?.project || OPERATOR, Math.max(0, layout.titleWidth - 2))
    const trackWidth = layout.trackWidth
    // The crawler rides the track. On a terminal it is painted into the track's
    // own cells; on the desktop it is the SVG layer above the rail. Either way
    // it never covers the stage, the percentage or the milestones, and it only
    // travels as far as the real progress allows.
    const crawler = await crawlerOf($, input, v, session.waiting > 0 || (await read($, guardsAtom)).length > 0)
    const waiting = crawler.crawler.state === 'query'
    const crawlerMotion: Motion = { now, reducedMotion }
    // The real head on the track, which is where the crawler may travel to.
    const headAt = positionAt(glide, now)
    const layer = layerFor(crawler.crawler, crawler.newest)
    const track = trackGrid(input, v, trackWidth, { head: headAt, now, motion, light: isLight })
    if (crawlerForm(trackWidth) === 'body') paintCrawler(track, { ...crawler.crawler, progress: headAt }, crawlerMotion, layer)
    const cells = track.encode()
    const secondary = secondaryText(input, layout.columns)
    // The Activity Field: a bounded tape of real activity above the HUD, and the
    // surface the crawler walks through. The crawler state is the existing one,
    // derived from what the host really reported, so the field and the rail can
    // never disagree about what is happening.
    const control = await read($, controlAtom)
    const runLedger = await read($, ledgerAtom)
    const graph: Graph | null = orchestrationGraph(runLedger, now) ?? graphOf(control.lastPrune, control.lastDecision)
    const tape = orchestrationTape(runLedger, e.props.bodyColumns, now) ?? tapeOf(liveOf(await read($, eventsAtom), now), e.props.bodyColumns)
    const fieldRowsWanted = fieldRowsOf(tape, graph, now, EVENT_TTL_MS)
    const fieldMotion = { now, reducedMotion }
    const walker = advance(fieldWalker, tape, crawler.crawler.state, fieldMotion)
    // The walker is module state rather than `$.state`: it is animation, not
    // fact, so a hot reload restarts it at whatever the real tape says rather
    // than restoring a position nothing observed.
    fieldWalker = walker
    const fieldRowsOut = fieldRows(tape, walker, crawler.crawler.state, e.props.bodyColumns)
    // The field as elements, for whichever surface is drawing. A terminal paints
    // it into a Raster the ticker can blit, a desktop draws it as SVG, and
    // anything else falls back to the same reading as styled text. With no real
    // events there is nothing to draw and no row is spent on it at all.
    const fieldColumns = e.props.bodyColumns
    const fieldCells = fieldGrid(tape, walker, crawler.crawler.state, fieldColumns, fieldRowsWanted).encode()
    const fieldVector = fieldSvg(tape, walker, crawler.crawler.state, graph, fieldColumns * 8, 14, now, EVENT_TTL_MS)
    const fieldText = fieldRowsOut.map((row, at) => (
      <Text key={`field-${at}`} wrap="truncate-end">
        {row.map((segment, n) => (
          <Text key={`field-${at}-${n}`} {...styleOf(segment)}>{segment.text}</Text>
        ))}
      </Text>
    ))
    const field = tape.anchors.length === 0 || fieldRowsWanted < 1
      ? null
      : e.surface === 'terminal' && Raster
        ? <Raster key={FIELD_KEY} columns={fieldColumns} rows={Math.min(2, fieldRowsWanted)} cells={fieldCells} />
        : Svg
          ? <Svg key={FIELD_KEY} source={fieldVector.svg} alt={fieldVector.alt} width={fieldColumns * 8} height={14} />
          : fieldText
    const flowDraw = { now, motion, light: isLight }
    const flowCellsNow = flowWanted ? flowGrid(flowOf(flowInput), flowWidth, flowDraw)?.encode() ?? null : null
    const flowTextRow = flowWanted ? flowRow(flowOf(flowInput), flowWidth, flowDraw) : null
    const flowEl = flowCellsNow !== null && e.surface === 'terminal' && Raster
      ? <Raster key={FLOW_KEY} columns={flowWidth} rows={1} cells={flowCellsNow} />
      : flowTextRow === null ? null : <Text key="flow-text" wrap="truncate-end">{flowTextRow.map((segment, n) => <Text key={`flow-${n}`} {...styleOf(segment)}>{segment.text}</Text>)}</Text>
    // NobodyWho, only while a real receipt is fresh. An empty list draws no row,
    // so a session with no receipts looks exactly as it always did.
    const flashRows = stripRows(await read($, flashAtom), now, layout.columns, reducedMotion)
    // The initialization line, shown only while it is genuinely still running.
    // Claude's own mascot is left untouched above it: there is no supported way
    // to replace it, and none is attempted here.
    const startup = startupOf(await read($, startupAtom), false)
    const resumed = await resumeLine($)
    const modelWarning = runLedger.warnings.at(-1) ?? null
    const guardNow = await guardView($)
    const guardLine = guardCfg.enabled ? `GUARD: ${guardLabel(guardCfg, guardNow.state, guardNow.kept)}` : null
    const startupRows: Row[] = startup.active && layout.columns >= 44 ? [[{ text: startup.line, color: COLORS.steel, isBold: true }]] : []
    let rail: RenderElement
    if (e.surface === 'terminal' && Raster) {
      const lastCells = new Map([[TRACK_KEY, cells]])
      // The field's own Raster is blitted from the same loop, so the crawler
      // keeps walking the tape between full redraws.
      if (field !== null) lastCells.set(FIELD_KEY, fieldCells)
      if (flowCellsNow !== null) lastCells.set(FLOW_KEY, flowCellsNow)
      band = { requestId: e.requestId, width: trackWidth, input, visual: v, agents: agents.shown, glide, motion, lastCells, waiting, field: field === null ? null : { tape, state: crawler.crawler.state, rows: Math.min(2, fieldRowsWanted), width: fieldColumns, graph }, flow: flowCellsNow === null ? null : { input: flowInput, width: flowWidth } }
      rail = <Raster key={TRACK_KEY} columns={trackWidth} rows={1} cells={cells} />
      startTicker($)
      if (!v.active && !agents.shown.some(a => a.state === 'running') && field === null) stopTicker()
    } else if (Svg) {
      band = null
      stopTicker()
      const width = trackWidth * TRACK_W
      const signature = JSON.stringify([input.task, v, width, motion])
      let cached = svgCache.get(id)
      if (cached?.signature !== signature) {
        cached = { signature, ...trackSvg(input, v, width, glide.from, motion) }
        svgCache.clear()
        svgCache.set(id, cached)
      }
      // The crawler's own SVG sits over the rail and is not interactive, so it
      // can never steal a hover from the stage checkpoints underneath it.
      const drawn = crawlerForm(trackWidth) === 'none' ? null : crawlerSvg({ ...crawler.crawler, progress: headAt }, { x: 0, y: 0, width, height: TRACK_H }, crawlerMotion, layer)
      rail = <Box width={width} height={TRACK_H}>
        <Svg key={TRACK_KEY} source={cached.base} alt={`${v.stage} ${v.percentText} ${STATE_LABEL[v.state]}`} width={width} height={TRACK_H} />
        <Box position="absolute" top={0} left={0}><Svg key="progress-hover" source={cached.overlay} alt="Stage and step checkpoints" width={width} height={TRACK_H} isInteractive /></Box>
        {drawn === null ? null : <Box position="absolute" top={0} left={0}><Svg key="crawler" source={drawn.svg} alt={drawn.alt} width={width} height={TRACK_H} /></Box>}
      </Box>
    } else {
      // A surface with neither Raster nor Svg: the same reading, as rows of
      // text, laid out by the same narrowing rules as everything else.
      band = null
      stopTicker()
      const rows = hudRows(input, layout.columns, e.props.maxRows)
      // `next(e)` first, then Cockpit's own rows. Every other plugin that draws
      // in this band composes the same way, and hooks run post-order with the
      // first plugin loaded outermost, so whichever of us is outer decides the
      // stack. Placing what we were given above our own rows means the reading
      // is the same either way round: whatever another plugin drew sits directly
      // above Cockpit's HUD, and neither plugin can suppress the other.
      const below = await next(e)

      return (
        <Box flexDirection="column">
          {below}
          {field}
          {rows.map((row, at) => (
            <Text key={`row-${at}`} wrap="truncate-end">
              {row.map(segment => (
                <Text {...styleOf(segment)}>{segment.text}</Text>
              ))}
            </Text>
          ))}
          {flowEl}
          {guardLine ? <Text dimColor wrap="truncate-end">{guardLine}</Text> : null}
        </Box>
      )
    }
    // The same composition as the text path above: anything another plugin drew
    // in this band is kept, and sits above Cockpit's HUD rather than replacing
    // it. This is what lets a second AbovePrompt plugin (a pasted-image viewer,
    // say) coexist instead of one of the two quietly swallowing the other.
    const below = await next(e)

    return (
      <Box flexDirection="column">
        {below}
        {field}
        <Box flexDirection="row" alignItems="center">
          {badge}
          {gutter}
          {layout.titleWidth > 0 ? <Text wrap="truncate-end">{`${title}${' '.repeat(Math.max(0, layout.titleWidth - cellsOf(title)))}   `}</Text> : null}
          {rail}
          {layout.percentWidth > 0 ? <Text color={STATE_COLOR[v.state]}>{` ${v.percentText.slice(0, layout.percentWidth)}`}</Text> : null}
        </Box>
        {secondary && e.props.maxRows > 1 ? <Text dimColor wrap="truncate-end">{secondary}</Text> : null}
        {flowEl}
        {guardLine ? <Text dimColor wrap="truncate-end">{guardLine}</Text> : null}
        {startupRows.map((row, at) => (
          <Text key={`startup-${at}`} wrap="truncate-end">
            {row.map((segment, n) => (
              <Text key={`startup-${at}-${n}`} {...styleOf(segment)}>{segment.text}</Text>
            ))}
          </Text>
        ))}
        {/* NobodyWho's one line, only while a real receipt is live. It costs a row
            only while there is something true to say, and is gone again after. */}
        {flashRows.map((row, at) => (
          <Text key={`nwho-${at}`} wrap="truncate-end">
            {row.map((segment, n) => (
              <Text key={`nwho-${at}-${n}`} {...styleOf(segment)}>{segment.text}</Text>
            ))}
          </Text>
        ))}
        {modelWarning ? <Text key="model-warning" color={COLORS.warn} wrap="truncate-end">{modelWarning}</Text> : null}
        {resumed ? <Text key="resume" color={COLORS.accent} wrap="truncate-end">{resumed}</Text> : null}
        {authWarning !== '' ? <Text key="auth-warning" color={COLORS.warn} bold wrap="truncate-end">{authWarning}</Text> : null}
        {crewLine !== '' ? <Text key="crew" color={COLORS.steel} wrap="truncate-end">{crewLine}</Text> : null}
        {agents.shown.map(a => {
          const state = a.state === 'waiting' ? 'needs_input' : a.state
          if (e.surface === 'terminal' && Raster) return <Box key={`row-${a.id}`} marginLeft={layout.titleWidth ? layout.titleWidth + 3 : 0}><Raster key={`agent-${a.id}`} columns={trackWidth} rows={1} cells={stripGrid(a, trackWidth, now, isLight, motion).encode()} /></Box>
          if (Svg) {
            const signature = JSON.stringify([a, trackWidth, isLight, motion])
            let cached = agentSvgCache.get(a.id)
            if (cached?.signature !== signature) {
              cached = { signature, source: stripSvg(a, trackWidth * TRACK_W, now, isLight, motion) }
              agentSvgCache.set(a.id, cached)
              if (agentSvgCache.size > 32) {
                // the first key is the oldest: removed by name, so no identifier
                // called `next` sits inside a hook body, where it reads as a pass-through
                for (const oldest of agentSvgCache.keys()) { agentSvgCache.delete(oldest); break }
              }
            }
            return <Box key={`row-${a.id}`} marginLeft={layout.titleWidth ? layout.titleWidth + 3 : 0}><Svg key={`agent-${a.id}`} source={cached.source} alt={hasRole(a) ? roleStrip(a, trackWidth, now) : `${a.title} ${a.tool} ${state}`} width={trackWidth * TRACK_W} height={18} /></Box>
          }
          return <Text color={STATE_COLOR[state]} wrap="truncate-end">{hasRole(a) ? roleStrip(a, layout.columns, now) : fitText(a.title, layout.columns)}</Text>
        })}
        {agents.folded > 0 && room > agents.shown.length ? <Text dimColor>{`+${agents.folded} more agents`}</Text> : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const activity = await read($, activityAtom)
    const input = await hudInput($, activity.isWorking)
    const state = visualStateOf(input, (await read($, visualAtom)).waiting > 0)
    const surface = $.ui.resolve(e)
    const Svg = 'Svg' in surface ? surface.Svg : null
    const base = paneRows(input, Math.max(20, e.props.bodyColumns), await $.clock.now())
    // LOCAL CONTROL is appended only when this session really observed a
    // NobodyWho receipt. With none, `controlRows` returns nothing and the
    // dossier is byte-for-byte what it was before Local Control existed.
    const control = await read($, controlAtom)
    const width = Math.max(20, e.props.bodyColumns)
    // ORCHESTRATION: who is main, what NobodyWho last did if it did anything,
    // and every subagent the engine really spawned. AUTH: how the session is
    // authenticated and the Fable policy with its counted calls. Fable is named
    // here, in the detailed diagnostics, and nowhere on the HUD.
    const session = await read($, visualAtom)
    const paneNow = await $.clock.now()
    const newest = control.lastPrune !== null && (control.lastDecision === null || control.lastPrune.at >= control.lastDecision.at) ? control.lastPrune : control.lastDecision
    const paneLedger = await read($, ledgerAtom)
    const paneRouter = await read($, routerAtom)
    const view: OrchestraView = {
      meter: input.meter,
      task: input.task,
      activity,
      isWorking: activity.isWorking,
      agents: session.agents,
      swarm: paneLedger.swarm,
      nwho: newest === null ? null : stripText(newest).replace(/^NWHO · /, ''),
      limit: config.maxSubagents,
      now: paneNow,
      ...(isSonnetLed() ? { profile: 'SONNET_LED' as const, consults: paneLedger.consults ?? [], usage: usageByTier(paneLedger.requests) } : {}),
      // the session router is named whenever one is selected, and in SONNET_LED also when it is OFF
      ...(paneRouter.mode !== 'OFF' || isSonnetLed() ? { router: routerLine(paneRouter) } : {}),
    }
    const rows = [
      ...base,
      ...(seenAny(control) ? controlRows(control, width, COLORS.accent) : []),
      ...heading('10', 'ORCHESTRATION', width, COLORS.accent),
      ...orchestraRows(view, width, COLORS),
      ...heading('11', 'AUTH', width, COLORS.accent),
      ...authRows(await read($, authAtom), await read($, policyAtom), COLORS, config.blocksFable),
    ].map(row => fit(row, width))
    const line = (row: Row): RenderElement =>
      row.length === 0 ? (
        <Text> </Text>
      ) : (
        <Text wrap="truncate-end">
          {row.map(segment => (
            <Text {...styleOf(segment)}>{segment.text}</Text>
          ))}
        </Text>
      )
    return (
      <Box flexDirection="column">
        {/* The operator's portrait, where the surface can draw one. The words
            beside it are already in the banner below, so this is only the art. */}
        {Svg ? <Svg source={mascotSvg(state, config.isAnimated && !reducedMotion)} alt={mascotAlt(state)} width={PANEL_W} height={PANEL_H} /> : null}
        {rows.map(line)}
        <Box marginTop={1} gap={1}>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => Promise.all([refreshGit($), refreshMeter($)]).then(() => undefined)} />
          <Button key="close" label="Close" hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const dialog = await next(e)
    try {
      const asked = e.props.questions[0] as { question?: unknown; header?: unknown } | undefined
      if (asked?.header !== GUARD_HEADER) return dialog
      const request = (await read($, guardsAtom)).find(one => one.question === asked.question)
      if (request === undefined) return dialog
      const git = await read($, gitAtom)
      const columns = Math.max(20, (e.viewport?.columns ?? 80) - 4)
      const { Box, Text } = $.ui.resolve(e)
      const stake =
        git !== null && git.isRepo
          ? `${git.project} · ${git.isDetached ? 'detached HEAD' : (git.branch ?? 'no branch')} · ${
              git.dirty === 0 ? 'working tree clean' : `${git.dirty} uncommitted change${git.dirty === 1 ? '' : 's'} at stake`
            }`
          : ''

      return (
        <Box flexDirection="column">
          <Box flexDirection="column" marginBottom={1}>
            <Text bold color={COLORS.bad}>
              BLAST RADIUS / HOLD{request.isSubagent ? '  · FROM SUBAGENT' : ''}
            </Text>
            <Text wrap="truncate-end">$ {oneLine(request.command, columns - 2)}</Text>
            {request.findings.map(finding => (
              <Text wrap="wrap">
                <Text color={COLORS.bad}> ▎✗ </Text>
                <Text bold>{finding.title}</Text>
                <Text dimColor> {finding.effect}</Text>
              </Text>
            ))}
            {stake !== '' && <Text dimColor>{stake}</Text>}
          </Box>
          {dialog}
        </Box>
      )
    } catch {
      return dialog
    }
  })
}
