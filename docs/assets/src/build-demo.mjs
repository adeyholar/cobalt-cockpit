#!/usr/bin/env node
// Builds the README demo animation from frames captured out of Cockpit itself.
//
//   node docs/assets/src/build-demo.mjs <run.log | frames.json> [--sha <commit>] [--scale 1.25] [--keep <dir>]
//
// The input is the log of the capture run (demo-capture.ts, see ../README.md), or a frame file written by an
// earlier build. Every captured row is what the plugin drew or printed in the offline test host for a synthetic
// scenario. This script adds presentation only: the window, the captions, the typed command line, the order and
// the timing. It changes no captured character. Two things it does to fit the screen, both marked: a tool reply
// is reflowed to the grid and, where it is longer than its space in the log, cut and marked [...] in the caption
// colour, which the plugin never prints; a pane is shown from its first row down to the height of the window,
// and its label says so. HUD rows and command output are drawn exactly as captured.
//
// Writes, next to this folder: demo/cockpit-demo.gif, demo/cockpit-demo-poster.png and demo/frames.json (the
// captured frames the animation and the README use, nothing else).
//
// Needs: Node 20+, Google Chrome or Chromium (it rasterises; its text shaping is the reference), ffmpeg.

import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '..', 'demo')

const args = process.argv.slice(2)
const FLAGS = new Set(['--scale', '--keep', '--sha', '--host'])
const opt = {}
let source = null
for (let i = 0; i < args.length; i++) {
  if (FLAGS.has(args[i])) opt[args[i]] = args[++i]
  else if (source === null) source = args[i]
}
if (!source) { console.error('usage: build-demo.mjs <run.log | frames.json> [--sha <commit>] [--host <version>] [--scale 1.25] [--keep <dir>]'); process.exit(2) }
const SCALE = Number(opt['--scale'] ?? '1.25')
const KEEP = opt['--keep'] ?? null

/** The frames out of a `claude plugin test` log: the capture prints each one as a line of its own. */
const fromLog = async log => {
  const frames = log.split('\n').filter(l => l.startsWith('@@FRAME@@')).map(l => JSON.parse(l.slice(9)))
  if (frames.length === 0) throw new Error('no @@FRAME@@ line in the log: was it the output of demo-capture.ts?')
  if (!/^ 1 pass$/m.test(log) || !/^ 0 fail$/m.test(log)) throw new Error('the capture run did not pass; frames from a failed run are not used')
  if (!log.includes('@@OUTBOUND@@[]')) throw new Error('the capture run does not show an empty outbound list')
  const host = opt['--host'] ?? (await run('claude', ['--version']).then(r => r.stdout.trim(), () => 'unknown'))
  const plugin = JSON.parse(readFileSync(resolve(HERE, '..', '..', '..', '.claude-plugin', 'plugin.json'), 'utf8'))
  return {
    meta: {
      synthetic: true,
      label: 'SYNTHETIC DEMO: the scenario input is synthetic; every row is output of the plugin code, run in the claude plugin test host. No model was called.',
      plugin: plugin.name, plugin_version: plugin.version, source_commit: opt['--sha'] ?? 'unknown', host,
    },
    frames,
  }
}
const raw = readFileSync(source, 'utf8')
const captured = raw.trimStart().startsWith('{') ? JSON.parse(raw) : await fromLog(raw)
const byId = new Map(captured.frames.map(f => [f.id, f]))
const frame = id => { const f = byId.get(id); if (!f) throw new Error(`no captured frame ${id}`); return f }

// ---------------------------------------------------------------------------------------------------------
// The screen: a caption bar (presentation), the body (captured rows on a 100-column grid), the prompt line.
// ---------------------------------------------------------------------------------------------------------

const COLS = 100
const CW = 8.4
const LH = 19
const FS = 14
const BASE = 14
const PAD = 22
const CAP_H = 58
const BODY_ROWS = 27
const BODY_Y = CAP_H + 22
const PROMPT_Y = BODY_Y + BODY_ROWS * LH + 7
const PROMPT_H = 28
const W = PAD * 2 + COLS * CW
const H = PROMPT_Y + PROMPT_H + 9
const FONT = `'DejaVu Sans Mono','Liberation Mono','Noto Mono',monospace`

// The body uses the plugin's own palette (hooks/theme.ts); the frame around it is the README's cobalt.
const C = {
  page: '#05070D', bar: '#0A1020', edge: '#22315C', body: '#07080A', prompt: '#0D0F13',
  cobalt: '#3D74FF', cobaltHi: '#7CA2FF', ink: '#E8EDFF', silver: '#C6CBD6', steel: '#7B8496', amber: '#FFB020',
}
// What a terminal theme would give the host's three colour tokens; the plugin's own glow tones.
const TOKEN = { success: '#3BE07F', error: '#FF5C7A', warning: '#FFB020' }

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const n2 = v => Math.round(v * 100) / 100
const colorOf = seg => {
  if (seg.color && seg.color.startsWith('#')) return seg.color
  if (seg.color && TOKEN[seg.color]) return TOKEN[seg.color]
  if (seg.color) throw new Error(`unmapped colour token ${seg.color}`)
  return seg.dim ? C.steel : C.silver
}

/** One captured row on the grid. Every character gets its own x, so a fallback glyph cannot shift its neighbours. */
const gridRow = (segs, y, x0 = PAD) => {
  let col = 0
  let out = ''
  for (const seg of segs) {
    const chars = [...seg.text]
    if (seg.bg) out += `<rect x="${n2(x0 + col * CW)}" y="${y}" width="${n2(chars.length * CW + 0.4)}" height="${LH}" fill="${seg.bg}"/>`
    const fill = colorOf(seg)
    let i = 0
    while (i < chars.length) {
      if (chars[i] === ' ') { i++; continue }
      let j = i
      while (j < chars.length && chars[j] !== ' ') j++
      const xs = Array.from({ length: j - i }, (_, k) => n2(x0 + (col + i + k) * CW)).join(' ')
      out += `<text x="${xs}" y="${y + BASE}" fill="${fill}"${seg.bold ? ' font-weight="700"' : ''}>${esc(chars.slice(i, j).join(''))}</text>`
      i = j
    }
    col += chars.length
  }
  return out
}

const plain = (text, color = null, extra = {}) => [{ text, color, bg: null, dim: false, bold: false, ...extra }]
const textOf = row => row.map(s => s.text).join('')

const wrap = (text, width) => {
  const lines = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line !== '' && [...line].length + 1 + [...word].length > width) { lines.push(line); line = word }
    else line = line === '' ? word : `${line} ${word}`
  }
  if (line !== '') lines.push(line)
  return lines
}

/** A tool reply in the log: the synthetic call in the caption colour, then the reply as it came back, at most `max` lines. */
const toolRows = (id, max = 3) => {
  const f = frame(id)
  const rows = [plain(`▸ ${f.call}`, C.cobaltHi)]
  const lines = f.rows.flatMap(r => wrap(textOf(r), COLS - 10))
  lines.slice(0, max).forEach((line, i) => {
    const cut = i === max - 1 && lines.length > max
    rows.push([{ text: `  ${line}`, color: null, bg: null, dim: false, bold: false }, ...(cut ? [{ text: ' [...]', color: C.cobaltHi, bg: null, dim: false, bold: false }] : [])])
  })
  return rows
}

const SCENES = [
  { title: 'STANDBY', text: 'The HUD band sits above the prompt. No task yet.',
    out: null, hud: ['s1-hud-100'], hold: 1500, contents: true },
  { title: 'PLAN', text: 'Scripted progress calls: Cockpit records acceptance criteria, five milestones and six gates.',
    typed: 'DEMO: add per-client rate limiting to the API gateway',
    out: { label: 'TOOL REPLIES', tools: ['t01', 't02'] }, hud: ['s2-hud-100'], hold: 2800 },
  { title: 'SWARM', text: 'One Haiku scout, two Sonnet engineers with separate write scopes. The reviewer has to wait.',
    out: { label: 'TOOL REPLIES', tools: ['t04', 't05', 't08', 't11', 't13'], max: 1 },
    hud: ['s3-tick-0', 's3-tick-1', 's3-tick-2', 's3-tick-3', 's3-tick-4', 's3-tick-5', 's3-tick-6', 's3-tick-7'], loops: 2, tick: 110, hold: 1100 },
  { title: 'AGENT INSPECTOR', text: 'Every task with its tier, its state and why it waits.',
    typed: '/cockpit agents', out: { label: 'COMMAND OUTPUT', command: 's3-agents' }, hud: ['s3-tick-7'], hold: 3200 },
  { title: 'INSPECT ONE TASK', text: 'Ownership, dependencies, effort as requested and as applied, and the blocker.',
    typed: '/cockpit agents REV-1', out: { label: 'COMMAND OUTPUT', command: 's3-agents-rev1' }, hud: ['s3-tick-7'], hold: 3800 },
  { title: 'REPORTED IS NOT VERIFIED', text: 'Agents reported. Only the result the commander checked counts as verified.',
    typed: '/cockpit agents', out: { label: 'COMMAND OUTPUT', command: 's4-agents' }, hud: ['s4-hud-100'], hold: 3200 },
  { title: 'A TEST FAILS', text: 'A scripted failing command. Cockpit reads the TEST gate from its exit status, not a claim.',
    out: { label: 'TOOL REPLIES', tools: ['t20', 't21'] }, hud: ['s5-hud-100'], hold: 2600 },
  { title: 'VERIFICATION READINESS', text: 'What stands between the task and DONE. It explains; it approves nothing.',
    typed: '/cockpit ready', out: { label: 'COMMAND OUTPUT', command: 's5-ready' }, hud: ['s5-hud-100'], hold: 3600 },
  { title: 'BLOCKED', text: 'The run needs a person. Cobalt Guard asks the host to notify and pins the alert on the HUD.',
    out: { label: 'TOOL REPLIES', tools: ['t22', 't23'] }, hud: ['s55-hud-100'], hold: 3200 },
  { title: 'GATES AND GOAL CHECK', text: 'Commands pass, results are verified, each criterion has evidence.',
    out: { label: 'TOOL REPLIES', tools: ['t38', 't39', 't40'] }, hud: ['s6-hud-100'], hold: 2800 },
  { title: 'PERMITS DONE', text: 'DONE only when every milestone is complete and every required gate holds.',
    typed: '/cockpit ready', out: { label: 'COMMAND OUTPUT', command: 's7-ready' }, hud: ['s7-hud-100'], hold: 3400 },
  { title: 'MISSION CONTROL', text: 'The dossier of the task: progress, milestones and the evidence behind each gate.',
    typed: '/cockpit', out: { label: 'PANE, FIRST 27 ROWS', pane: 's6-pane-100' }, hud: null, hold: 3600 },
  { title: 'RUN LEDGER', text: 'What was observed, kept locally. What the host did not report stays unknown.',
    typed: '/ledger', out: { label: 'PANE, FIRST 27 ROWS', pane: 's6-ledger' }, hud: null, hold: 3000 },
]

const outputRows = out => {
  if (out === null) return []
  if (out.tools) return out.tools.flatMap(id => toolRows(id, out.max ?? 3))
  if (out.command) return frame(out.command).rows
  return frame(out.pane).rows.slice(0, BODY_ROWS)
}

const usedIds = new Set()
for (const s of SCENES) {
  for (const id of s.hud ?? []) usedIds.add(id)
  for (const id of s.out?.tools ?? []) usedIds.add(id)
  if (s.out?.command) usedIds.add(s.out.command)
  if (s.out?.pane) usedIds.add(s.out.pane)
}
// Frames the README quotes as text, kept in the published frame file beside the ones the animation draws.
for (const id of ['s3-hud-100', 's3-agents-eng1', 's3-flow', 's6-flow', 's6-agents', 's5-ready', 's6-ready']) usedIds.add(id)

/** One whole screen as SVG. `typed` is what the prompt line shows; `cursor` draws the block after it. */
const screen = ({ index, scene, hudId, typed = '', showOut = true }) => {
  const out = showOut ? outputRows(scene.out) : []
  const hud = hudId ? frame(hudId).rows : []
  let body = ''
  const rule = (top, label) => `<line x1="${PAD}" y1="${top - 9.5}" x2="${n2(W - PAD - 14 - label.length * 6.8)}" y2="${top - 9.5}" stroke="${C.edge}" stroke-width="1" stroke-dasharray="2 4"/>` +
    `<text x="${W - PAD}" y="${top - 6}" text-anchor="end" font-size="9.5" fill="${C.steel}" letter-spacing="1">${label}</text>`
  const hudTop = BODY_Y + (BODY_ROWS - hud.length) * LH
  // above the band, one row of air under the transcript; a pane has no band and starts at the top
  const outTop = hud.length > 0 ? hudTop - (out.length + 1) * LH : BODY_Y
  if (outTop < BODY_Y) throw new Error(`${scene.title}: ${out.length} output rows do not fit above a ${hud.length}-row band`)
  // the first screen has no transcript yet: it carries the contents of the loop, in the caption colours
  if (scene.contents) {
    const x = PAD, y = BODY_Y + 30, half = Math.ceil(SCENES.length / 2)
    body += `<text x="${x}" y="${y}" font-size="12" font-weight="700" fill="${C.amber}" letter-spacing="1.4">SYNTHETIC DEMO</text>`
    body += `<text x="${x}" y="${y + 22}" font-size="12.5" fill="${C.silver}">Cockpit v${captured.meta.plugin_version ?? ''} output, captured in Claude Code's offline plugin test host. Scripted task; no model ran.</text>`
    body += `<text x="${x}" y="${y + 41}" font-size="12.5" fill="${C.steel}">The band, panes, command output and tool replies are the plugin's own. The frame and captions are not.</text>`
    body += `<text x="${x}" y="${y + 84}" font-size="11" fill="${C.cobaltHi}" letter-spacing="1.4">THIS LOOP</text>`
    SCENES.forEach((sc, i) => {
      const cx = x + (i < half ? 0 : 420), cy = y + 110 + (i < half ? i : i - half) * 23
      body += `<text x="${cx}" y="${cy}" font-size="12.5" fill="${C.steel}">${String(i + 1).padStart(2, '0')}</text><text x="${cx + 30}" y="${cy}" font-size="12.5" fill="${C.silver}" letter-spacing="0.6">${esc(sc.title)}</text>`
    })
  }
  if (out.length > 0) body += rule(outTop, scene.out.label)
  out.forEach((row, i) => { body += gridRow(row, outTop + i * LH) })
  // what was printed before stays above, dimmed, as scrollback does in a terminal; whatever no longer fits is gone
  if (hud.length > 0 && out.length > 0) {
    let bottom = outTop - LH
    let older = ''
    for (let k = index - 1; k >= 0 && bottom > BODY_Y; k--) {
      const prev = SCENES[k].out
      if (!prev || prev.pane) continue
      const rows = outputRows(prev)
      const top = bottom - rows.length * LH
      rows.forEach((row, i) => { if (top + i * LH >= BODY_Y) older += gridRow(row, top + i * LH) })
      if (top - LH >= BODY_Y - 6) older += rule(top, prev.label)
      bottom = top - LH
    }
    body += `<g opacity=".34">${older}</g>`
  }
  if (hud.length > 0) {
    body += rule(hudTop, 'HUD BAND')
    hud.forEach((row, i) => { body += gridRow(row, hudTop + i * LH) })
  }
  const ticks = SCENES.map((_, i) => `<rect x="${n2(W - PAD - (SCENES.length - i) * 9 + 3)}" y="38" width="6" height="${i === index ? 9 : 5}" fill="${i === index ? C.cobaltHi : C.edge}"/>`).join('')
  const typedChars = [...typed].length
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" font-size="${FS}">
<rect width="${W}" height="${H}" fill="${C.body}"/>
<rect width="${W}" height="${CAP_H}" fill="${C.bar}"/>
<rect y="${CAP_H - 1}" width="${W}" height="1" fill="${C.edge}"/>
<rect x="0" y="0" width="3" height="${CAP_H - 1}" fill="${C.cobalt}"/>
<text x="${PAD}" y="24" font-size="15" font-weight="700" fill="${C.ink}" letter-spacing="1.2">${esc(scene.title)}</text>
<text x="${PAD}" y="45" font-size="12.5" fill="${C.silver}">${esc(scene.text)}</text>
<rect x="${W - PAD - 118}" y="11" width="118" height="19" fill="none" stroke="${C.amber}" stroke-width="1"/>
<text x="${W - PAD - 59}" y="24.5" text-anchor="middle" font-size="11" font-weight="700" fill="${C.amber}" letter-spacing="1.1">SYNTHETIC DEMO</text>
${ticks}
${body}
<rect x="0" y="${PROMPT_Y}" width="${W}" height="${PROMPT_H}" fill="${C.prompt}"/>
<rect x="0" y="${PROMPT_Y}" width="${W}" height="1" fill="${C.edge}"/>
<text x="${PAD}" y="${PROMPT_Y + 19}" fill="${C.cobaltHi}" font-weight="700">&gt;</text>
${typed === '' ? '' : gridRow(plain(typed, C.ink), PROMPT_Y + 5, PAD + 2 * CW)}
<rect x="${n2(PAD + (2 + typedChars) * CW + 1)}" y="${PROMPT_Y + 7}" width="${CW - 1.4}" height="15" fill="${C.cobaltHi}"/>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="none" stroke="${C.edge}" stroke-width="1"/>
</svg>
`
}

// ---------------------------------------------------------------------------------------------------------
// The storyboard as a list of (screen, duration). A typed command is drawn over the screen before it runs.
// ---------------------------------------------------------------------------------------------------------

const shots = []
let posterShot = -1
SCENES.forEach((scene, index) => {
  if (scene.typed) {
    const before = SCENES[index - 1]
    const beforeHud = before.hud ? before.hud[before.hud.length - 1] : null
    const chars = [...scene.typed]
    const steps = chars.length > 24 ? 4 : 3
    for (let s = 1; s <= steps; s++) {
      const typed = chars.slice(0, Math.ceil((chars.length * s) / steps)).join('')
      shots.push({ svg: screen({ index: index - 1, scene: before, hudId: beforeHud, typed }), ms: s === steps ? 320 : 110 })
    }
  }
  const hud = scene.hud ?? [null]
  const loops = scene.loops ?? 1
  for (let l = 0; l < loops; l++) hud.forEach((hudId, i) => {
    const last = l === loops - 1 && i === hud.length - 1
    shots.push({ svg: screen({ index, scene, hudId }), ms: last ? scene.hold : scene.tick, title: scene.title })
    if (last && scene.title === 'AGENT INSPECTOR') posterShot = shots.length - 1
  })
})

const work = KEEP ? resolve(KEEP) : mkdtempSync(join(tmpdir(), 'cockpit-demo-'))
mkdirSync(work, { recursive: true })
mkdirSync(OUT, { recursive: true })

// identical screens are rasterised once
const unique = new Map()
shots.forEach(shot => { if (!unique.has(shot.svg)) unique.set(shot.svg, `f${String(unique.size).padStart(3, '0')}`) })
for (const [svg, name] of unique) writeFileSync(join(work, `${name}.svg`), svg)

const chrome = process.env.CHROME_BIN ?? 'google-chrome'
const raster = async name => {
  // a profile of its own per process: nothing of the operator's browser profile is read, locked or written
  const profile = join(work, `profile-${name}`)
  await run(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    `--force-device-scale-factor=${SCALE}`, `--window-size=${Math.ceil(W)},${Math.ceil(H)}`,
    `--screenshot=${join(work, `${name}.png`)}`, pathToFileURL(join(work, `${name}.svg`)).href], { timeout: 60_000 })
  rmSync(profile, { recursive: true, force: true })
}
const names = [...unique.values()]
for (let i = 0; i < names.length; i += 6) await Promise.all(names.slice(i, i + 6).map(raster))

const list = shots.map(shot => `file '${join(work, `${unique.get(shot.svg)}.png`)}'\nduration ${(shot.ms / 1000).toFixed(3)}`).join('\n') +
  `\nfile '${join(work, `${unique.get(shots[shots.length - 1].svg)}.png`)}'\n`
writeFileSync(join(work, 'list.txt'), list)
const gif = join(OUT, 'cockpit-demo.gif')
await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(work, 'list.txt'),
  '-filter_complex', '[0:v]split[a][b];[a]palettegen=max_colors=200:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
  '-fps_mode', 'vfr', '-loop', '0', gif], { timeout: 300_000 })

const poster = join(OUT, 'cockpit-demo-poster.png')
copyFileSync(join(work, `${unique.get(shots[posterShot].svg)}.png`), join(work, 'poster-raw.png'))
await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(work, 'poster-raw.png'),
  '-filter_complex', '[0:v]split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=none', '-frames:v', '1', '-update', '1', poster], { timeout: 60_000 })

// The captured frames this README uses, one per line, with the capture's own description of itself.
const kept = captured.frames.filter(f => usedIds.has(f.id))
const meta = { ...captured.meta, note: 'A subset of the capture: the frames the README animation and text quote. How to regenerate: docs/assets/README.md.' }
writeFileSync(join(OUT, 'frames.json'), `{\n"meta": ${JSON.stringify(meta)},\n"frames": [\n${kept.map(f => JSON.stringify(f)).join(',\n')}\n]\n}\n`)

if (KEEP) shots.forEach((shot, i) => { if (shot.title) console.log(`shot ${i} ${unique.get(shot.svg)} ${shot.ms} ms ${shot.title}`) })
const total = shots.reduce((sum, s) => sum + s.ms, 0)
console.log(`${shots.length} shots, ${unique.size} distinct screens, ${(total / 1000).toFixed(1)} s loop, ${Math.ceil(W * SCALE)}x${Math.ceil(H * SCALE)} px`)
for (const f of [gif, poster, join(OUT, 'frames.json')]) console.log(`${f.replace(resolve(HERE, '..', '..', '..') + '/', '')}: ${statSync(f).size} bytes`)
if (!KEEP) rmSync(work, { recursive: true, force: true })
