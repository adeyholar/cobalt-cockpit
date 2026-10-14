// Guard calibration labels live in the shared plugin store, one key per label, read fresh on every command.
// These tests play a second session by writing the store directly, and check sweep, refusals, privacy and export.
// Synthetic: nothing here shows that a person saw anything.
import { expect, test } from 'claude-code/testing'
import { bounded, episodesOf, occKeyOf } from '../hooks/alerts'
import type { AlertKind, AlertRecord } from '../hooks/alerts'
import { simulate, simulationConfigOf } from '../hooks/calibration'
import type { Ledger } from '../types'
import { FIVE, hostState, progress, start, world } from './world'

const projectHash = async (cwd: string): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cobalt-cockpit/alerts/v1\0${cwd}`)))].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
const rec = (key: string, over: Partial<AlertRecord> = {}): AlertRecord => ({ key, kind: 'run-blocked', taskId: 1, at: 1000, outcome: 'recorded', attempts: 0, channel: null, ...over })
/** A command typed at the terminal, or from the origin given (an explicit undefined stays undefined). */
const say = async ($: any, args: string, ...as: unknown[]) => String((await $.command.run({ command: 'cockpit', args, origin: as.length === 0 ? { kind: 'composer' } : as[0], presentation: { isFullscreen: true, columns: 120 } } as never) as { text?: string }).text)
const session = (on: any, id = 's1') => on('session.id', () => ({ value: id }))
const occurrence = (n: number): { id: string, records: AlertRecord[] } => {
  const records = bounded([], rec(`${n}@${n}:run-blocked:task`, { taskId: n, at: 900_000 + n }))
  return { id: episodesOf(records)[0]!.id, records }
}
const labelKeys = (store: Map<string, unknown>): string[] => [...store.keys()].filter(k => k.startsWith('alert-label:')).sort()
const labelKey = (project: string, id: string): string => `alert-label:${project}:${id}`
const lcg = (seed: number): (() => number) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 } }
const OPTIONS = { guardRecordOnly: true }

test('a label written by another session shows in review and calibration at once', { options: OPTIONS }, async ($, on) => {
  const project = await projectHash('/work/example')
  const a = occurrence(1)
  const w = world(on, {}, { [occKeyOf(project, a.id)]: { v: 1, records: a.records } })
  hostState(on, {})
  await start($)
  expect(await say($, 'alerts review')).toContain(a.id)
  w.store.set(labelKey(project, a.id), { v: 1, label: 'NOISE', at: 1 })
  const review = await say($, 'alerts review')
  expect(review).toContain(a.id)
  expect(review).toContain('NOISE')
  expect(await say($, 'alerts calibration')).toContain('NOISE')
})

test('a label cleared by another session disappears from review at once', { options: OPTIONS }, async ($, on) => {
  const project = await projectHash('/work/example')
  const a = occurrence(1)
  const w = world(on, {}, { [occKeyOf(project, a.id)]: { v: 1, records: a.records }, [labelKey(project, a.id)]: { v: 1, label: 'NOISE', at: 1 } })
  hostState(on, {})
  await start($)
  expect(await say($, 'alerts review')).toContain('NOISE')
  w.store.delete(labelKey(project, a.id))
  expect(await say($, 'alerts review')).not.toContain('NOISE')
})

test('an occurrence another session recorded after start is reviewable and labelable and survives the sweep', { options: OPTIONS }, async ($, on) => {
  const project = await projectHash('/work/example')
  const a = occurrence(1)
  const b = occurrence(2)
  const w = world(on, {}, { [occKeyOf(project, a.id)]: { v: 1, records: a.records } })
  hostState(on, {})
  await start($)
  w.store.set(occKeyOf(project, b.id), { v: 1, records: b.records })
  expect(await say($, 'alerts review')).toContain(b.id)
  expect(await say($, `alerts label ${b.id} notify`)).toContain('is labelled NOTIFY')
  expect(await say($, `alerts label ${a.id} record`)).toContain('is labelled')
  expect(w.store.get(labelKey(project, b.id))).toEqual({ v: 1, label: 'NOTIFY', at: 1_000_000 })
})

test('another session label of B survives this session setting and clearing A', { options: OPTIONS }, async ($, on) => {
  const project = await projectHash('/work/example')
  const a = occurrence(1)
  const b = occurrence(2)
  const w = world(on, {}, { [occKeyOf(project, a.id)]: { v: 1, records: a.records }, [occKeyOf(project, b.id)]: { v: 1, records: b.records } })
  hostState(on, {})
  await start($)
  w.store.set(labelKey(project, b.id), { v: 1, label: 'RECORD_ONLY', at: 5 })
  await say($, `alerts label ${a.id} notify`)
  expect(w.store.get(labelKey(project, b.id))).toEqual({ v: 1, label: 'RECORD_ONLY', at: 5 })
  await say($, `alerts label ${a.id} clear`)
  expect(w.store.get(labelKey(project, b.id))).toEqual({ v: 1, label: 'RECORD_ONLY', at: 5 })
  expect(w.store.has(labelKey(project, a.id))).toBe(false)
})

test('two sessions labelling one occurrence differently leave the later write standing', { options: OPTIONS }, async ($, on) => {
  const project = await projectHash('/work/example')
  const a = occurrence(1)
  const w = world(on, {}, { [occKeyOf(project, a.id)]: { v: 1, records: a.records } })
  hostState(on, {})
  await start($)
  w.store.set(labelKey(project, a.id), { v: 1, label: 'NOISE', at: 3 })
  await say($, `alerts label ${a.id} notify`)
  expect(w.store.get(labelKey(project, a.id))).toEqual({ v: 1, label: 'NOTIFY', at: 1_000_000 })
  w.store.set(labelKey(project, a.id), { v: 1, label: 'NOISE', at: 4 })
  expect(await say($, 'alerts review')).toContain('NOISE')
})

test('an orphan label is deleted by the next accepted label command only', { options: OPTIONS }, async ($, on) => {
  const project = await projectHash('/work/example')
  const a = occurrence(1)
  const orphan = labelKey(project, 'deadbeef')
  const w = world(on, {}, { [occKeyOf(project, a.id)]: { v: 1, records: a.records }, [orphan]: { v: 1, label: 'NOISE', at: 1 } })
  hostState(on, {})
  await start($)
  await say($, 'alerts review')
  await say($, 'alerts calibration')
  await say($, 'alerts label')
  expect(w.store.has(orphan)).toBe(true)
  await say($, `alerts label ${a.id} notify`, { kind: 'sdk' })
  expect(w.store.has(orphan)).toBe(true)
  await say($, `alerts label ${a.id} notify`)
  expect(w.store.has(orphan)).toBe(false)
  expect(w.store.has(labelKey(project, a.id))).toBe(true)
})

test('labels of another project are kept with occurrences and deleted without', { options: OPTIONS }, async ($, on) => {
  const project = await projectHash('/work/example')
  const other = await projectHash('/work/elsewhere')
  const a = occurrence(1)
  const o = occurrence(2)
  const kept = labelKey(other, o.id)
  const gone = labelKey(other, 'cafef00d')
  const w = world(on, {}, {
    [occKeyOf(project, a.id)]: { v: 1, records: a.records },
    [occKeyOf(other, o.id)]: { v: 1, records: o.records },
    [kept]: { v: 1, label: 'NOTIFY', at: 1 },
    [gone]: { v: 1, label: 'NOTIFY', at: 1 },
  })
  hostState(on, {})
  await start($)
  await say($, `alerts label ${a.id} notify`)
  expect(w.store.has(kept)).toBe(true)
  expect(w.store.has(gone)).toBe(false)
})

test('a label whose occurrence is only in an earlier-format history is kept', { options: OPTIONS }, async ($, on) => {
  const project = await projectHash('/work/example')
  const a = occurrence(1)
  const h = occurrence(2)
  const v58 = occurrence(3)
  const hKey = labelKey(project, h.id)
  const v58Key = labelKey('abcdefabcdef', v58.id)
  const w = world(on, {}, {
    [occKeyOf(project, a.id)]: { v: 1, records: a.records },
    [`alert-history:${project}`]: { v: 1, alerts: h.records },
    'alert-history': { v: 1, projects: { abcdefabcdef: v58.records } },
    [hKey]: { v: 1, label: 'NOISE', at: 1 },
    [v58Key]: { v: 1, label: 'NOISE', at: 1 },
  })
  hostState(on, {})
  await start($)
  await say($, `alerts label ${a.id} notify`)
  expect(w.store.has(hKey)).toBe(true)
  expect(w.store.has(v58Key)).toBe(true)
})

test('an unreadable earlier-format history keeps every label of its project', { options: OPTIONS }, async ($, on) => {
  const project = await projectHash('/work/example')
  const a = occurrence(1)
  const orphan = labelKey(project, 'deadbeef')
  const w = world(on, {}, { [occKeyOf(project, a.id)]: { v: 1, records: a.records }, [`alert-history:${project}`]: 'garbage', [orphan]: { v: 1, label: 'NOISE', at: 1 } })
  hostState(on, {})
  await start($)
  await say($, `alerts label ${a.id} notify`)
  expect(w.store.has(orphan)).toBe(true)
})

test('malformed label keys are never deleted', { options: OPTIONS }, async ($, on) => {
  const project = await projectHash('/work/example')
  const a = occurrence(1)
  const bad = ['alert-label:zz', `alert-label:${project}:deadbeef:x`, `alert-label:${project.toUpperCase()}:deadbeef`, `alert-label:${project}:DEADBEEF`]
  const seed: Record<string, unknown> = { [occKeyOf(project, a.id)]: { v: 1, records: a.records } }
  for (const k of bad) seed[k] = { v: 1, label: 'NOISE', at: 1 }
  const w = world(on, {}, seed)
  hostState(on, {})
  await start($)
  await say($, `alerts label ${a.id} notify`)
  await say($, `alerts label ${a.id} clear`)
  for (const k of bad) expect(w.store.has(k)).toBe(true)
})

test('an occurrence that expires loses its label at the next accepted label command', { options: OPTIONS }, async ($, on) => {
  const project = await projectHash('/work/example')
  const a = occurrence(1)
  const b = occurrence(2)
  const w = world(on, {}, { [occKeyOf(project, a.id)]: { v: 1, records: a.records } })
  hostState(on, {})
  await start($)
  w.store.set(occKeyOf(project, b.id), { v: 1, records: b.records })
  await say($, `alerts label ${b.id} notify`)
  expect(w.store.has(labelKey(project, b.id))).toBe(true)
  w.store.delete(occKeyOf(project, b.id))
  expect(w.store.has(labelKey(project, b.id))).toBe(true)
  await say($, `alerts label ${a.id} notify`)
  expect(w.store.has(labelKey(project, b.id))).toBe(false)
})

test('a seeded interleaving of two sessions never loses a live label', { options: OPTIONS }, async ($, on) => {
  const project = await projectHash('/work/example')
  const rnd = lcg(20260603)
  const created: Array<{ id: string, records: AlertRecord[] }> = []
  const seed: Record<string, unknown> = {}
  for (let n = 1; n <= 6; n++) { const o = occurrence(n); created.push(o); seed[occKeyOf(project, o.id)] = { v: 1, records: o.records } }
  const w = world(on, {}, seed)
  hostState(on, {})
  await start($)
  const verbs = ['notify', 'record', 'noise', 'clear']
  for (let round = 0; round < 60; round++) {
    const live = labelKeys(w.store).filter(k => w.store.has(`alert-occ:${project}:${k.split(':')[2]}`))
    const pick = created[Math.floor(rnd() * created.length)]!
    const action = Math.floor(rnd() * 5)
    let skip: string | null = null
    if (action === 0) {
      const verb = verbs[Math.floor(rnd() * verbs.length)]!
      await say($, `alerts label ${pick.id} ${verb}`)
      if (verb === 'clear') skip = labelKey(project, pick.id)
    } else if (action === 1) {
      w.store.set(labelKey(project, pick.id), { v: 1, label: 'NOISE', at: round })
    } else if (action === 2) {
      w.store.delete(labelKey(project, pick.id))
      skip = labelKey(project, pick.id)
    } else if (action === 3) {
      w.store.delete(occKeyOf(project, pick.id))
    } else {
      const o = occurrence(created.length + 1)
      created.push(o)
      w.store.set(occKeyOf(project, o.id), { v: 1, records: o.records })
    }
    for (const k of live) {
      if (k === skip) continue
      if (!w.store.has(`alert-occ:${project}:${k.split(':')[2]}`)) continue
      expect(w.store.has(k)).toBe(true)
    }
    expect(labelKeys(w.store).length).toBeLessThanOrEqual(created.length)
  }
  // one more accepted label command: every label left belongs to an occurrence the store still holds
  const alive = created.find(o => w.store.has(occKeyOf(project, o.id)))
  if (alive !== undefined) {
    await say($, `alerts label ${alive.id} record`)
    for (const k of labelKeys(w.store)) expect(w.store.has(`alert-occ:${project}:${k.split(':')[2]}`)).toBe(true)
  }
})

const CORRUPT: unknown[] = ['NOTIFY', 7, null, [], { v: 2, label: 'NOTIFY', at: 1 }, { v: 1, label: 'URGENT', at: 1 }, { v: 1, label: 'NOTIFY', at: 1, note: 'free text' }]
for (const [i, bad] of CORRUPT.entries()) {
  test(`an unreadable label value (case ${i}) reads as unreviewed, survives the sweep, and is replaced or cleared by a command`, { options: OPTIONS }, async ($, on) => {
    const project = await projectHash('/work/example')
    const a = occurrence(1)
    const b = occurrence(2)
    const w = world(on, {}, { [occKeyOf(project, a.id)]: { v: 1, records: a.records }, [occKeyOf(project, b.id)]: { v: 1, records: b.records }, [labelKey(project, a.id)]: bad })
    hostState(on, {})
    await start($)
    expect(await say($, 'alerts review')).toContain('its stored label could not be read')
    expect(await say($, 'alerts calibration')).toContain('could not be read')
    await say($, `alerts label ${b.id} notify`)
    expect(w.store.get(labelKey(project, a.id))).toEqual(bad)
    await say($, `alerts label ${a.id} noise`)
    expect(w.store.get(labelKey(project, a.id))).toEqual({ v: 1, label: 'NOISE', at: 1_000_000 })
    w.store.set(labelKey(project, a.id), bad)
    await say($, `alerts label ${a.id} clear`)
    expect(w.store.has(labelKey(project, a.id))).toBe(false)
  })
}

test('corrupt occurrence values are ignored without a crash', { options: OPTIONS }, async ($, on) => {
  const project = await projectHash('/work/example')
  const a = occurrence(1)
  const b = occurrence(2)
  const c = occurrence(3)
  const d = occurrence(4)
  const w = world(on, {}, {
    [occKeyOf(project, a.id)]: { v: 2, records: a.records },
    [occKeyOf(project, b.id)]: { v: 1, records: 'nope' },
    [occKeyOf(project, c.id)]: { v: 1, records: d.records },
    [occKeyOf(project, d.id)]: { v: 1, records: d.records },
  })
  hostState(on, {})
  await start($)
  expect(await say($, 'alerts review')).toContain(d.id)
  expect(await say($, 'alerts calibration')).toBeTruthy()
  expect(w.store.has(labelKey(project, a.id))).toBe(false)
})

test('a failed label write is reported and leaves no key', { options: OPTIONS }, async ($, on) => {
  const project = await projectHash('/work/example')
  const a = occurrence(1)
  const w = world(on, {}, { [occKeyOf(project, a.id)]: { v: 1, records: a.records } })
  hostState(on, {})
  await start($)
  w.failStoreWrites.push(labelKey(project, a.id))
  const text = await say($, `alerts label ${a.id} notify`)
  expect(text).toContain('could not be recorded. Nothing was changed.')
  expect(labelKeys(w.store)).toEqual([])
})

const STALE = 'Cockpit: no recorded alert has that id. It may be mistyped, or it may have expired from the bounded history. Nothing was changed.'
const MALFORMED = 'Cockpit: an alert id is 8 characters, 0-9 and a-f, as /cockpit alerts review lists it. Nothing was changed.'
const refusals: Array<[string, string]> = [
  ['deadbeef', STALE],
  ['abc', MALFORMED],
  ['123456789', MALFORMED],
  ['zzzzzzzz', MALFORMED],
  ['../../x', MALFORMED],
  ['a'.repeat(200), MALFORMED],
]
for (const [id, expected] of refusals) {
  test(`the id "${id.slice(0, 12)}" is refused with no store write`, { options: OPTIONS }, async ($, on) => {
    const project = await projectHash('/work/example')
    const a = occurrence(1)
    const w = world(on, {}, { [occKeyOf(project, a.id)]: { v: 1, records: a.records } })
    hostState(on, {})
    await start($)
    const before = w.storeWrites.length
    expect(await say($, `alerts label ${id} notify`)).toContain(expected)
    expect(w.storeWrites.length).toBe(before)
    expect(labelKeys(w.store)).toEqual([])
  })
}

test('an expired id is refused as unknown with no store write', { options: OPTIONS }, async ($, on) => {
  const project = await projectHash('/work/example')
  const a = occurrence(1)
  const b = occurrence(2)
  const w = world(on, {}, { [occKeyOf(project, a.id)]: { v: 1, records: a.records } })
  hostState(on, {})
  await start($)
  w.store.set(occKeyOf(project, b.id), { v: 1, records: b.records })
  w.store.delete(occKeyOf(project, b.id))
  const before = w.storeWrites.length
  expect(await say($, `alerts label ${b.id} notify`)).toContain(STALE)
  expect(w.storeWrites.length).toBe(before)
})

test('an uppercase hex id is accepted', { options: OPTIONS }, async ($, on) => {
  const project = await projectHash('/work/example')
  const a = occurrence(1)
  const w = world(on, {}, { [occKeyOf(project, a.id)]: { v: 1, records: a.records } })
  hostState(on, {})
  await start($)
  expect(await say($, `alerts label ${a.id.toUpperCase()} notify`)).toContain('is labelled NOTIFY')
  expect(w.store.has(labelKey(project, a.id))).toBe(true)
})

test('label keys and values are closed in shape and carry no path, key or task text', { options: OPTIONS }, async ($, on) => {
  const project = await projectHash('/work/example')
  const a = occurrence(1)
  const b = occurrence(2)
  const w = world(on, {}, { [occKeyOf(project, a.id)]: { v: 1, records: a.records }, [occKeyOf(project, b.id)]: { v: 1, records: b.records } })
  hostState(on, {})
  await start($)
  await say($, `alerts label ${a.id} notify`)
  await say($, `alerts label ${b.id} noise`)
  const keys = labelKeys(w.store)
  expect(keys.length).toBe(2)
  for (const k of keys) {
    expect(k).toMatch(/^alert-label:[0-9a-f]{12}:[0-9a-f]{8}$/)
    const v = w.store.get(k) as Record<string, unknown>
    expect(Object.keys(v).sort()).toEqual(['at', 'label', 'v'])
    expect(['NOTIFY', 'RECORD_ONLY', 'NOISE']).toContain(v.label)
  }
  const dump = JSON.stringify(keys.map(k => [k, w.store.get(k)]))
  for (const bad of ['/work', 'example', 'needs the owner', '@1:run-blocked', '@2:run-blocked']) expect(dump).not.toContain(bad)
  for (const text of [await say($, 'alerts review'), await say($, 'alerts calibration')]) {
    expect(text).not.toContain('/work')
    expect(text).not.toContain('@1:run-blocked')
    expect(text).not.toContain('@2:run-blocked')
  }
})

const exportJson = (text: string): unknown => JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
const hasLabelProperty = (v: unknown): boolean => Array.isArray(v) ? v.some(hasLabelProperty) : v !== null && typeof v === 'object' ? Object.entries(v).some(([k, x]) => k === 'label' || hasLabelProperty(x)) : false

test('the alerts export is byte-identical and label-free after labelling', { options: OPTIONS }, async ($, on) => {
  const project = await projectHash('/work/example')
  const a = occurrence(1)
  const w = world(on, {}, { [occKeyOf(project, a.id)]: { v: 1, records: a.records } })
  hostState(on, {})
  session(on)
  await start($)
  const before = await say($, 'alerts export')
  expect(before).toContain(a.id)
  await say($, `alerts label ${a.id} notify`)
  expect(w.store.has(labelKey(project, a.id))).toBe(true)
  const after = await say($, 'alerts export')
  expect(after).toBe(before)
  expect(after).not.toMatch(/label/i)
  const parsed = exportJson(after) as { version?: number }
  expect(parsed.version).toBe(2)
  expect(hasLabelProperty(parsed)).toBe(false)
})

// Histories written before v0.6.3 load unchanged, and their occurrences can be reviewed and labelled.
const SINGLE = 'alert-history'
test('a v0.5.7 history is reviewable and labelable, and labelling changes neither the inbox nor the occurrence keys', { options: OPTIONS }, async ($, on) => {
  const project = await projectHash('/work/example')
  const a = occurrence(1)
  const b = occurrence(2)
  const w = world(on, {}, { [SINGLE]: { v: 1, projects: { [project]: [...a.records, ...b.records] } } })
  hostState(on, {})
  session(on)
  await start($)
  const occKeys = (): string[] => [...w.store.keys()].filter(k => k.startsWith('alert-occ:')).sort()
  const inbox = await say($, 'alerts')
  const keys = occKeys()
  expect(inbox).toContain(a.id)
  expect(inbox).toContain(b.id)
  const review = await say($, 'alerts review')
  expect(review).toContain(a.id)
  expect(review).toContain(b.id)
  expect(await say($, `alerts label ${a.id} record`)).toContain('is labelled RECORD_ONLY')
  expect(occKeys()).toEqual(keys)
  // the look the first inbox made is counted on the next one; the occurrences and their lines are as they were
  const lines = (text: string): string[] => text.split('\n').filter(l => /^  [0-9a-f]{8} /.test(l))
  expect(lines(await say($, 'alerts'))).toEqual(lines(inbox))
})

test('a v0.5.8 history held in this session only, with both settings off, keeps its label through the sweep', { options: {} }, async ($, on) => {
  const project = await projectHash('/work/example')
  const a = occurrence(1)
  const b = occurrence(2)
  const w = world(on, {}, { [`alert-history:${project}`]: { v: 1, alerts: [...a.records, ...b.records] } })
  hostState(on, {})
  session(on)
  await start($)
  // with both settings off nothing is migrated: the occurrences have no keys of their own
  expect([...w.store.keys()].filter(k => k.startsWith('alert-occ:'))).toEqual([])
  expect(await say($, `alerts label ${a.id} notify`)).toContain('is labelled NOTIFY')
  expect(await say($, `alerts label ${b.id} noise`)).toContain('is labelled NOISE')
  expect(labelKeys(w.store)).toEqual([labelKey(project, a.id), labelKey(project, b.id)].sort())
  expect(await say($, 'alerts calibration')).toContain('2 recorded · 2 reviewed · 0 unreviewed')
})

// The simulation agrees with the live alert pass: the same options, the same occurrence, the same moment.
const LIVE = { guardAlerts: true, guardCooldownSec: 30, guardMaxAlerts: 20 }
const QUIET = { guardQuietHours: '00:00-00:30', guardQuietTimezone: 'UTC' }
const raise = async ($: any, kind: 'run-blocked' | 'security-failure'): Promise<void> => {
  await progress($, { action: 'plan', milestones: FIVE.slice(0, 3) })
  if (kind === 'run-blocked') await progress($, { action: 'block', milestone: 'm1', note: 'needs the owner' })
  else await progress($, { action: 'gate', gate: 'SECURITY', state: 'fail', evidence: 'x' })
}
const liveOf = (held: ReturnType<typeof hostState>, kind: AlertKind): AlertRecord => {
  const r = ((held.get('run-ledger')!.value as Ledger).alerts ?? []).find(a => a.kind === kind)
  if (r === undefined) throw new Error(`no live record of ${kind}`)

  return r
}
const OUTCOME_OF: Record<string, string> = { sent: 'notify', deferred: 'defer', silenced: 'none' }
const CASES: { name: string; extra: Record<string, unknown>; kind: 'run-blocked' | 'security-failure'; later?: number; live: string; told: number }[] = [
  { name: 'an ordinary alert in quiet hours is deferred', extra: QUIET, kind: 'run-blocked', live: 'deferred', told: 0 },
  { name: 'a critical alert in quiet hours is sent', extra: QUIET, kind: 'security-failure', live: 'sent', told: 1 },
  { name: 'a critical alert deferred by guardQuietCritical is deferred', extra: { ...QUIET, guardQuietCritical: 'defer' }, kind: 'security-failure', live: 'deferred', told: 0 },
  { name: 'a kind left out of guardNotifyKinds is not notified', extra: { guardNotifyKinds: 'none' }, kind: 'run-blocked', live: 'silenced', told: 0 },
  { name: 'security-failure is notified with guardNotifyKinds none', extra: { guardNotifyKinds: 'none' }, kind: 'security-failure', live: 'sent', told: 1 },
  { name: 'an ordinary alert after the window is sent', extra: QUIET, kind: 'run-blocked', later: 3_600_000, live: 'sent', told: 1 },
]
for (const c of CASES) {
  test(`live and simulated agree: ${c.name}`, { options: { ...LIVE, ...c.extra } }, async ($, on) => {
    const w = world(on, {})
    const held = hostState(on, {})
    session(on)
    await start($)
    if (c.later !== undefined) await w.clock.advance(c.later)
    await raise($, c.kind)
    const live = liveOf(held, c.kind)
    expect(live.outcome).toBe(c.live)
    expect(w.notified.length).toBe(c.told)
    const sim = simulate(simulationConfigOf({ ...LIVE, ...c.extra }, 'UTC'), live)
    expect(sim.outcome).toBe(OUTCOME_OF[c.live])
    // the same options with alerts off and record-only on are simulated the same way: the question is what alerts would have done
    expect(simulate(simulationConfigOf({ guardRecordOnly: true, ...c.extra }, 'UTC'), live)).toEqual(sim)
  })
}

test('a record-only incident is simulated as the live pass would have treated it, and nothing is sent', { options: { guardRecordOnly: true, ...QUIET } }, async ($, on) => {
  const w = world(on, {})
  const held = hostState(on, {})
  session(on)
  await start($)
  await raise($, 'run-blocked')
  const recorded = liveOf(held, 'run-blocked')
  expect(recorded.outcome).toBe('recorded')
  expect(simulate(simulationConfigOf({ guardRecordOnly: true, ...QUIET }, 'UTC'), recorded).outcome).toBe('defer')
  expect(await say($, 'alerts calibration')).toContain('would notify 0 · would defer for quiet hours 1 · would not notify 0')
  expect(w.notified).toEqual([])
})
