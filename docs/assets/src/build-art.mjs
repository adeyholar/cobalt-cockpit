#!/usr/bin/env node
// Builds the README artwork: the hero banner and the six module keys, each in a dark and a light variant.
//
//   node docs/assets/src/build-art.mjs            write the SVG files
//   node docs/assets/src/build-art.mjs --png      also rasterise the static hero fallbacks (needs Chrome)
//
// Original vector artwork, written as code so it can be regenerated and read line by line. Nothing here is a
// screenshot and nothing is presented as a live run: the banner is an illustration built from the product's
// own vocabulary and colours.
//
//   - VECTOR, the hooded operator, is the portrait hooks/mascot.ts draws (same paths, idle face), as on the
//     listing icon.
//   - The tier colours are the Neural Flow tones of hooks/flow.ts, dark and light: violet Opus, cyan Sonnet,
//     amber Haiku, green verified. Cobalt is the frame, and is the README's own.
//   - The flow row, the gate names and every label are words the HUD prints.
//
// Text is set in the viewer's monospace font with a pinned textLength, so a different font changes the
// letterforms and never the layout; every glyph outside ASCII is drawn as a shape. The title is drawn, not typeset.
// Motion is additive: the picture is complete without it, and prefers-reduced-motion switches it off.

import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ASSETS = resolve(HERE, '..')
const ROOT = resolve(ASSETS, '..', '..')

const THEMES = {
  dark: {
    page: '#05070D', panel: '#080D1A', well: '#0B1224', grid: '#16234A', edge: '#24345F', rule: '#1B2748',
    cobalt: '#3D74FF', cobaltHi: '#7CA2FF', ink: '#E8EDFF', silver: '#C6CBD6', steel: '#7B8496',
    opus: '#B18CFF', sonnet: '#22E3F0', haiku: '#FFB020', ok: '#3BE07F', glow: 0.16, gridOpacity: 0.55,
  },
  light: {
    page: '#F6F8FD', panel: '#FFFFFF', well: '#EEF2FB', grid: '#DDE4F4', edge: '#B4C1E0', rule: '#CCD6EE',
    cobalt: '#1F4FD8', cobaltHi: '#3D74FF', ink: '#0B1020', silver: '#3A4152', steel: '#646A7E',
    opus: '#6B3FD4', sonnet: '#0B7C93', haiku: '#AD6400', ok: '#18883A', glow: 0.1, gridOpacity: 0.7,
  },
}

const FONT = `ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono','DejaVu Sans Mono',monospace`
const n = v => Math.round(v * 100) / 100
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Monospace text with its width pinned: `track` is extra space per character. Returns [markup, width]. */
const mono = (x, y, s, size, fill, o = {}) => {
  const step = size * 0.6 + (o.track ?? 0)
  const width = s.length * step - (o.track ?? 0)
  const attrs = [
    `x="${n(x)}"`, `y="${n(y)}"`, `font-size="${size}"`, `fill="${fill}"`, `textLength="${n(width)}"`,
    o.weight ? `font-weight="${o.weight}"` : '', o.anchor ? `text-anchor="${o.anchor}"` : '', o.opacity ? `opacity="${o.opacity}"` : '', o.cls ? `class="${o.cls}"` : '',
  ].filter(Boolean).join(' ')
  return [`<text ${attrs}>${esc(s)}</text>`, width, step]
}
const text = (...a) => mono(...a)[0]
/** Pieces of one line in different colours, laid end to end on the same grid. */
const line = (x, y, parts, size, track = 0) => {
  let at = x
  let out = ''
  for (const [s, fill, weight] of parts) {
    // a renderer drops the spaces at either end of a text element, so they are kept as distance instead
    const step = size * 0.6 + track
    const lead = s.length - s.trimStart().length
    out += mono(at + lead * step, y, s.trim(), size, fill, { track, weight })[0]
    at += s.length * step
  }
  return [out, at]
}

// ---------------------------------------------------------------------------------------------------------
// The title: a drawn stencil alphabet on a 4 x 6 grid, chamfered corners, one stroke weight.
// ---------------------------------------------------------------------------------------------------------

const SW = 0.92
const GLYPH = {
  C: 'M4 0H1L0 1V5L1 6H4',
  O: 'M1 0H3L4 1V5L3 6H1L0 5V1Z',
  B: 'M0 0H3L4 1V2L3 3L4 4V5L3 6H0ZM0 3H3',
  A: 'M0 6V1L1 0H3L4 1V6M0 3.7H4',
  L: 'M0 0V6H4',
  T: 'M0 0H4M2 0V6',
  K: 'M0 0V6M4.6 -0.63L1.15 3L4.6 6.63M0 3H1.15',
  P: 'M0 6V0H3L4 1V2.7L3 3.7H0',
  I: 'M0 0V6',
  S: 'M4 0H1L0 1V2L1 3H3L4 4V5L3 6H0',
  W: 'M0 0V6L2 3.4L4 6V0',
  R: 'M0 6V0H3L4 1V2.7L3 3.7H0M2 3.7L4.5 6.9',
  M: 'M0 6V0L2 2.6L4 0V6',
  F: 'M4 0H0V6M0 3H3',
  N: 'M0 6V0L4 6V0',
  E: 'M4 0H0V6H4M0 3H3',
  D: 'M0 0H3L4 1V5L3 6H0Z',
  Y: 'M0 0V1.6L2 3.4L4 1.6V0M2 3.4V6',
  G: 'M4 0H1L0 1V5L1 6H3L4 5V3.2H2.2',
  U: 'M0 0V5L1 6H3L4 5V0',
}
const SPAN = { I: 0 }
// letters with a diagonal are cut to the letter box, so a mitre never rises above the cap line
const CUT = new Set(['K', 'W', 'R', 'M', 'N', 'Y'])
/** A drawn word. `gap` is the space between letter boxes, in grid units. Returns [paths, width in units]. */
const word = (letters, gap, weight = SW) => {
  let at = 0
  let paths = ''
  ;[...letters].forEach((ch, i) => {
    paths += `<path d="${GLYPH[ch]}"${at ? ` transform="translate(${n(at)} 0)"` : ''}${CUT.has(ch) ? ' clip-path="url(#box)"' : ''}/>`
    at += (SPAN[ch] ?? 4) + (i < letters.length - 1 ? weight + gap : 0)
  })
  return [paths, at]
}

// ---------------------------------------------------------------------------------------------------------
// VECTOR: the portrait of hooks/mascot.ts, idle face, unchanged.
// ---------------------------------------------------------------------------------------------------------

const COWL = 'M13 1.4c-4.9 0-8.9 3.7-9.4 8.5L3 20.6h20l-.6-10.7c-.5-4.8-4.5-8.5-9.4-8.5z'
const COWL_INNER = 'M13 3.6c-3.8 0-7.1 2.8-7.5 6.6l-.3 6.4h15.6l-.3-6.4c-.4-3.8-3.7-6.6-7.5-6.6z'
const MASK = 'M7.1 10.9h11.8a1.2 1.2 0 0 1 1.2 1.4l-.5 3.2a1.3 1.3 0 0 1-1.3 1.1H7.7a1.3 1.3 0 0 1-1.3-1.1l-.5-3.2a1.2 1.2 0 0 1 1.2-1.4z'
const vector = (x, y, scale) => `<g transform="translate(${x} ${y}) scale(${scale})">
<path d="${COWL}" fill="#0D0F13" stroke="#1D222B" stroke-width="1"/>
<path d="${COWL_INNER}" fill="#07080A"/>
<path d="${MASK}" fill="#05070A"/>
<g clip-path="url(#visor)"><rect x="5.4" y="14.8" width="15.2" height="2.6" fill="#8A90A2" opacity=".1"/><g fill="#fff"><rect x="9" y="13.1" width="2.6" height="1.2"/><rect x="14.4" y="13.1" width="2.6" height="1.2"/></g></g>
<path d="${MASK}" fill="none" stroke="#646A7E" stroke-opacity=".6" stroke-width="1"/>
<rect x="10.4" y="18.4" width="5.2" height=".9" rx=".45" fill="#646A7E" opacity=".5"/>
</g>`

// ---------------------------------------------------------------------------------------------------------
// The hero.
// ---------------------------------------------------------------------------------------------------------

const W = 1280
const H = 600

const hero = (t, animated) => {
  const U = 14
  const TX = 72
  const stroke = SW * U
  const [cockpit, cockpitSpan] = word('COCKPIT', 0.48)
  const cobaltGap = (cockpitSpan - 6 * 4) / 5 - SW
  const [cobalt] = word('COBALT', cobaltGap)
  const titleW = cockpitSpan * U + stroke
  const y1 = 104 + stroke / 2
  const y2 = y1 + 6 * U + stroke + 20
  const ox = TX + stroke / 2
  const titleGroup = (paths, y, color, extra = '') => `<g transform="translate(${n(ox)} ${n(y)}) scale(${U})" fill="none" stroke="${color}" stroke-width="${SW}" stroke-linecap="square" stroke-linejoin="miter"${extra}>${paths}</g>`

  // ---- left: title block
  const subY = y2 + 6 * U + stroke / 2 + 34
  const sub = 'MISSION CONTROL FOR CLAUDE CODE'
  const subSize = 19
  const subTrack = (titleW - sub.length * subSize * 0.6) / (sub.length - 1)
  const tag = ['Orchestrate bounded agents.', 'Track real progress.', 'Verify before declaring done.']
  const tagSize = 16.5
  const tagY = subY + 36
  let left = ''
  left += `<g opacity="${t === THEMES.dark ? 0.3 : 0.16}" filter="url(#soft)">${titleGroup(cobalt, y1, t.cobalt)}</g>`
  left += titleGroup(cobalt, y1, 'url(#cobaltInk)')
  left += titleGroup(cockpit, y2, t.ink)
  // the tear: a displaced band of the title, the mascot's own glitch, at rest unless motion is on
  left += `<g clip-path="url(#tear)" class="tear">${titleGroup(cobalt, y1, t.sonnet, ' transform-origin="0 0"')}</g>`
  left += mono(TX, subY, sub, subSize, t.silver, { track: subTrack, weight: 600 })[0]
  tag.forEach((s, i) => {
    left += text(TX, tagY + i * 25, '>', tagSize, t.cobaltHi, { weight: 700 })
    left += text(TX + tagSize * 0.6 * 2, tagY + i * 25, s, tagSize, t.ink)
  })
  const curX = TX + tagSize * 0.6 * (2 + tag[2].length) + 5
  left += `<rect class="cur" x="${n(curX)}" y="${n(tagY + 50 - 13.5)}" width="9" height="16.5" fill="${t.cobaltHi}"/>`

  // ---- top bar
  let top = vector(56, 30, 2)
  top += line(122, 59, [['VECTOR', t.ink, 700]], 15)[0]
  top += text(122 + 15 * 0.6 * 6 + 14, 59, 'CONSOLE / MISSION', 12, t.steel, { track: 0.6 })
  top += text(1224, 59, 'OBSERVE BY DEFAULT · ENFORCE BY OPT-IN', 11.5, t.steel, { anchor: 'end', track: 0.9 })
  top += `<path d="M56 86.5H1224" stroke="${t.rule}" stroke-width="1"/>`

  // ---- right: the swarm
  const X0 = 590, X1 = 1208, Y0 = 96, Y1 = 440
  const CX = 899, CY = 190, R = 30
  const hex = (cx, cy, r) => Array.from({ length: 6 }, (_, i) => { const a = (Math.PI / 3) * i - Math.PI / 2; return `${n(cx + r * Math.cos(a))} ${n(cy + r * Math.sin(a))}` }).join('L')
  const pool = (x, label, role, words, color, cap, nodes) => {
    let out = `<path d="M${x} 286H${x + 258}L${x + 270} 298V396H${x + 12}L${x} 384Z" fill="${t.well}" stroke="${t.edge}" stroke-width="1"/>`
    out += `<path d="M${x} 300V286H${x + 22}" fill="none" stroke="${color}" stroke-width="1.6"/>`
    out += line(x + 16, 311, [[label, color, 700], [` / ${role}`, t.steel]], 12.5)[0]
    out += nodes
    out += text(x + 254, 349, cap, 10.5, t.steel, { anchor: 'end', track: 0.5 })
    out += text(x + 16, 380, words, 10.5, t.steel, { track: 0.5 })
    return out
  }
  const bracket = (cx, cy, r, color) => `<path d="M${cx - r} ${cy - r + 5}V${cy - r}H${cx - r + 5}M${cx + r - 5} ${cy - r}H${cx + r}V${cy - r + 5}M${cx + r} ${cy + r - 5}V${cy + r}H${cx + r - 5}M${cx - r + 5} ${cy + r}H${cx - r}V${cy + r - 5}" fill="none" stroke="${color}" stroke-width="1" opacity=".55"/>`
  const sonnetNodes = [0, 1, 2].map(i => {
    const cx = 640 + i * 44, cy = 344
    const queued = i === 2
    return bracket(cx, cy, 17, t.sonnet) + `<rect x="${cx - 10}" y="${cy - 10}" width="20" height="20" fill="${queued ? 'none' : t.sonnet}" fill-opacity="${queued ? 0 : 0.2}" stroke="${t.sonnet}" stroke-width="1.6"${queued ? ' stroke-dasharray="3 3" opacity=".6"' : ''}/>` +
      (queued ? '' : `<rect x="${cx - 3.5}" y="${cy - 3.5}" width="7" height="7" fill="${t.sonnet}"/>`)
  }).join('')
  const haikuNodes = [0, 1, 2, 3].map(i => {
    const cx = 946 + i * 31, cy = 344
    const queued = i === 3
    return `<circle cx="${cx}" cy="${cy}" r="9" fill="${queued ? 'none' : t.haiku}" fill-opacity="${queued ? 0 : 0.2}" stroke="${t.haiku}" stroke-width="1.6"${queued ? ' stroke-dasharray="3 3" opacity=".6"' : ''}/>` +
      (queued ? '' : `<circle cx="${cx}" cy="${cy}" r="3" fill="${t.haiku}"/>`)
  }).join('')
  let right = `<path d="M${X0} ${Y0}H${X1 - 16}L${X1} ${Y0 + 16}V${Y1}H${X0 + 16}L${X0} ${Y1 - 16}Z" fill="${t.panel}" stroke="${t.edge}" stroke-width="1"/>`
  right += `<g clip-path="url(#scope)">`
  right += [70, 124, 178].map(r => `<circle cx="${CX}" cy="${CY}" r="${r}" fill="none" stroke="${t.grid}" stroke-width="1"/>`).join('')
  right += `<rect x="${X0}" y="${Y0}" width="${X1 - X0}" height="${Y1 - Y0}" fill="url(#lines)"/>`
  right += `<rect class="scan" x="${X0 - 90}" y="${Y0}" width="90" height="${Y1 - Y0}" fill="url(#sweep)"/>`
  right += `</g>`
  right += text(X0 + 20, 122, 'SWARM / TOPOLOGY', 12, t.silver, { track: 1.2, weight: 600 })
  right += line(X1 - 20 - 18 * (11.5 * 0.6 + 0.6), 122, [['PROFILE / ', t.steel], ['OPUS_LED', t.opus, 700]], 11.5, 0.6)[0]
  right += `<path d="M${X0 + 20} 136.5H${X1 - 20}" stroke="${t.rule}" stroke-width="1"/>`
  // delegation: commander down to both pools
  right += `<path d="M${CX} ${CY + R}V258M745 286V258H1053V286" fill="none" stroke="${t.edge}" stroke-width="1.6"/>`
  // evidence travelling back up to the commander: at rest these are not drawn
  right += `<path class="pulse p1" d="M745 286V258H${CX}V${CY + R}" fill="none" stroke="${t.sonnet}" stroke-width="2.4" stroke-linecap="round"/>`
  right += `<path class="pulse p2" d="M1053 286V258H${CX}V${CY + R}" fill="none" stroke="${t.haiku}" stroke-width="2.4" stroke-linecap="round"/>`
  // escalation: Haiku to Sonnet to Opus
  right += `<path d="M918 344H886M640 286V${CY}H${CX - R - 8}" fill="none" stroke="${t.opus}" stroke-width="1.2" stroke-dasharray="2 5" opacity=".8"/>`
  right += `<path d="M882 344l7 -4v8zM${CX - R - 3} ${CY}l-7 -4v8z" fill="${t.opus}" opacity=".8"/>`
  right += text(652, 182, 'ESCALATION', 10, t.opus, { track: 1 })
  // the commander
  right += `<path class="breathe" d="M${hex(CX, CY, R + 9)}Z" fill="${t.opus}" opacity="${t.glow}"/>`
  right += `<path d="M${hex(CX, CY, R)}Z" fill="${t.well}" stroke="${t.opus}" stroke-width="2"/>`
  right += `<path d="M${CX} ${CY - 11}L${CX + 11} ${CY}L${CX} ${CY + 11}L${CX - 11} ${CY}Z" fill="${t.opus}"/>`
  right += line(CX + 46, 186, [['OPUS 5.5', t.opus, 700], [' / COMMANDER', t.steel]], 14)[0]
  right += text(CX + 46, 206, 'PLAN · DELEGATE · INTEGRATE · VERIFY', 10.5, t.steel, { track: 0.3 })
  right += pool(610, 'SONNET 5.5', 'ENGINEER', 'ENGINEER · DEBUG · REVIEW', t.sonnet, 'AUTO / UP TO 8', sonnetNodes)
  right += pool(918, 'HAIKU 5.5', 'SCOUT', 'SCOUT · INVENTORY · CLASSIFY', t.haiku, 'AUTO / UP TO 16', haikuNodes)
  right += text(X0 + 20, 422, 'OWNERSHIP · WAVES · BACKPRESSURE', 10.5, t.steel, { track: 1.1 })
  right += text(X1 - 20, 422, 'EVIDENCE BEFORE DONE', 10.5, t.steel, { anchor: 'end', track: 1.1 })

  // ---- the flow row: the Neural Flow as the HUD prints it, drawn rather than typed
  const FY = 488
  const NODES = [['INPUT', 'ok'], ['DISCOVERY', 'ok'], ['ROUTING', 'ok'], ['WORKERS', 'ok'], ['VERIFY', 'active'], ['DONE', 'pending']]
  const fSize = 13.5
  const fStep = fSize * 0.6 + 0.8
  const G = 14
  const fixed = NODES.reduce((sum, [name]) => sum + G + 8 + name.length * fStep - 0.8, 0)
  const FX0 = 138, FX1 = 1224
  const edge = (FX1 - FX0 - fixed) / 5
  let flow = text(TX, FY + 4.5, 'FLOW', 11, t.steel, { track: 1.6 })
  let fx = FX0
  NODES.forEach(([name, state], i) => {
    const color = state === 'ok' ? t.ok : state === 'active' ? t.opus : t.steel
    const cx = fx + G / 2
    if (state === 'ok') flow += `<circle cx="${n(cx)}" cy="${FY}" r="5.6" fill="${color}"/>`
    else if (state === 'active') flow += `<circle cx="${n(cx)}" cy="${FY}" r="6" fill="none" stroke="${color}" stroke-width="1.8"/><circle class="breathe" cx="${n(cx)}" cy="${FY}" r="2.6" fill="${color}"/>`
    else flow += `<circle cx="${n(cx)}" cy="${FY}" r="5.4" fill="none" stroke="${color}" stroke-width="1.5"/>`
    flow += text(fx + G + 8, FY + 4.7, name, fSize, color, { track: 0.8, weight: state === 'pending' ? 400 : 600 })
    fx += G + 8 + name.length * fStep - 0.8
    if (i < NODES.length - 1) {
      const a = fx + 14, b = fx + edge - 14
      const next = NODES[i + 1][1]
      if (next === 'pending') flow += `<path d="M${n(a)} ${FY + 3}H${n(b)}" stroke="${t.steel}" stroke-width="2" stroke-dasharray="2 6" stroke-linecap="round" opacity=".7"/>`
      else {
        const c = next === 'active' ? t.opus : t.ok
        flow += `<path d="M${n(a)} ${FY - 3}H${n(b)}M${n(a)} ${FY + 3}H${n(b)}" stroke="${c}" stroke-width="2" stroke-dasharray="2 6" stroke-linecap="round" opacity="${next === 'active' ? 0.75 : 0.9}"/>`
        if (next === 'active') {
          // the travelling marker and its two trailing cells; at rest it sits beside the node it feeds
          const span = b - a - 40
          flow += `<g class="mark" style="--span:${n(-span)}px"><path d="M${n(b - 5)} ${FY - 6.5}l6.5 6.5l-6.5 6.5l-6.5 -6.5z" fill="${c}"/><rect x="${n(b - 21)}" y="${FY - 4}" width="6" height="8" fill="${c}" opacity=".6"/><rect x="${n(b - 31)}" y="${FY - 1}" width="6" height="5" fill="${c}" opacity=".35"/></g>`
        }
      }
      fx += edge
    }
  })

  // ---- the gates and the two standing rows
  const GY = 532
  const gSize = 12.5
  const gStep = gSize * 0.6 + 0.6
  const GATES = [['CODE', 'pass'], ['TEST', 'pass'], ['TYPE', 'pass'], ['BUILD', 'pending'], ['SECURITY', 'unset'], ['GIT', 'unset']]
  let gates = text(TX, GY, 'GATES', 11, t.steel, { track: 1.6 })
  let gx = FX0
  for (const [name, state] of GATES) {
    gates += text(gx, GY, name, gSize, state === 'unset' ? t.steel : t.silver, { track: 0.6, weight: 600 })
    gx += name.length * gStep + 8
    const cy = GY - 4.5
    if (state === 'pass') gates += `<path d="M${n(gx)} ${cy}l3.6 3.8l7 -8" fill="none" stroke="${t.ok}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`
    else if (state === 'pending') gates += `<circle cx="${n(gx + 5.5)}" cy="${cy}" r="5" fill="none" stroke="${t.haiku}" stroke-width="1.8" stroke-dasharray="2.6 2.6"/>`
    else gates += `<circle cx="${n(gx + 5.5)}" cy="${cy}" r="1.6" fill="${t.steel}"/>`
    gx += 12 + 24
  }
  const chip = (xEnd, label, color, mark) => {
    const w = label.length * (11 * 0.6 + 0.9) + 40
    const x = xEnd - w
    return [`<path d="M${n(x)} ${GY - 16}H${n(xEnd - 7)}L${n(xEnd)} ${GY - 9}V${GY + 7}H${n(x + 7)}L${n(x)} ${GY}Z" fill="${t.well}" stroke="${t.edge}" stroke-width="1"/>` + mark(x + 14, GY - 4.5, color) +
      text(x + 27, GY - 0.5, label, 11, t.silver, { track: 0.9, weight: 600 }), x]
  }
  const [guardChip, guardX] = chip(FX1, 'GUARD: ARMED', t.haiku, (x, y, c) => `<path d="M${n(x)} ${n(y - 5.5)}l6 10.5h-12z" fill="none" stroke="${c}" stroke-width="1.6" stroke-linejoin="round"/>`)
  const [ledgerChip] = chip(guardX - 12, 'RUN LEDGER / LOCAL', t.cobaltHi, (x, y, c) => `<path d="M${n(x - 6)} ${n(y - 4.5)}h12M${n(x - 6)} ${n(y)}h8M${n(x - 6)} ${n(y + 4.5)}h12" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/>`)
  gates += guardChip + ledgerChip

  // ---- frame
  const frame = `<path d="M38 20H1242L1260 38V562L1242 580H38L20 562V38Z" fill="none" stroke="${t.edge}" stroke-width="1.2"/>` +
    `<path d="M20 74V38L38 20H74M1206 20H1242L1260 38V74M1260 526V562L1242 580H1206M74 580H38L20 562V526" fill="none" stroke="${t.cobalt}" stroke-width="2"/>` +
    Array.from({ length: 25 }, (_, i) => `<path d="M${496 + i * 12} 580v${i % 6 === 0 ? -8 : -4}" stroke="${t.edge}" stroke-width="1"/>`).join('') +
    `<path d="M56 458.5H1224" stroke="${t.rule}" stroke-width="1"/>`

  const style = `
text{font-family:${FONT};font-kerning:none}
${animated ? `
@keyframes sweep{0%{transform:translateX(0);opacity:0}12%{opacity:.9}88%{opacity:.9}100%{transform:translateX(${X1 - X0 + 90}px);opacity:0}}
@keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}
@keyframes breathe{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes glowbreathe{0%,100%{opacity:${t.glow}}50%{opacity:${n(t.glow * 2.4)}}}
@keyframes travel{0%{transform:translateX(var(--span))}100%{transform:translateX(0)}}
@keyframes evidence{0%{stroke-dashoffset:0;opacity:0}8%{opacity:1}92%{opacity:1}100%{stroke-dashoffset:-270;opacity:0}}
@keyframes tear{0%,91%,100%{transform:translateX(0);opacity:0}92%{transform:translateX(7px);opacity:.85}95%{transform:translateX(-4px);opacity:.6}98%{transform:translateX(3px);opacity:.8}}
.scan{animation:sweep 9s linear infinite}
.cur{animation:blink 1.15s steps(1) infinite}
.breathe{animation:breathe 2.6s ease-in-out infinite}
path.breathe{animation:glowbreathe 3.4s ease-in-out infinite}
.mark{animation:travel 2.4s linear infinite}
.pulse{stroke-dasharray:22 270;animation:evidence 3.6s linear infinite}
.p2{animation-delay:1.8s}
.tear{animation:tear 8s steps(1) infinite}
@media (prefers-reduced-motion:reduce){.scan,.cur,.breathe,.mark,.pulse,.tear{animation:none!important}}` : ''}
.scan,.pulse,.tear{opacity:0}`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">Cobalt Cockpit: Mission Control for Claude Code</title>
<desc id="d">Illustration of a tactical control panel. The title COBALT COCKPIT with the lines: Orchestrate bounded agents. Track real progress. Verify before declaring done. Beside it a swarm diagram: an Opus commander delegating to a Sonnet engineer pool and a Haiku scout pool, with escalation back up. Below, the Neural Flow from INPUT through DISCOVERY, ROUTING and WORKERS to VERIFY and DONE, the six verification gates CODE, TEST, TYPE, BUILD, SECURITY and GIT, a Run Ledger marker and a Cobalt Guard marker.</desc>
<defs>
<clipPath id="box"><rect x="${-SW / 2}" y="${-SW / 2}" width="${4 + SW}" height="${6 + SW}"/></clipPath>
<clipPath id="visor"><path d="${MASK}"/></clipPath>
<clipPath id="page"><path d="M38 20H1242L1260 38V562L1242 580H38L20 562V38Z"/></clipPath>
<clipPath id="scope"><path d="M${X0} ${Y0}H${X1 - 16}L${X1} ${Y0 + 16}V${Y1}H${X0 + 16}L${X0} ${Y1 - 16}Z"/></clipPath>
<clipPath id="tear"><rect x="${TX - 20}" y="${n(y1 + 2.1 * U)}" width="${n(titleW + 40)}" height="${n(0.9 * U)}"/></clipPath>
<pattern id="lines" width="4" height="4" patternUnits="userSpaceOnUse"><path d="M0 .5H4" stroke="${t.ink}" stroke-width="1" opacity=".035"/></pattern>
<pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="${t.grid}" stroke-width="1"/></pattern>
<linearGradient id="cobaltInk" gradientUnits="userSpaceOnUse" x1="0" y1="${-SW}" x2="0" y2="${6 + SW}"><stop offset="0" stop-color="${t.cobaltHi}"/><stop offset="1" stop-color="${t.cobalt}"/></linearGradient>
<linearGradient id="sweep" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${t.sonnet}" stop-opacity="0"/><stop offset=".85" stop-color="${t.sonnet}" stop-opacity=".1"/><stop offset="1" stop-color="${t.sonnet}" stop-opacity=".45"/></linearGradient>
<radialGradient id="lift" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(300 230) scale(520 300)"><stop offset="0" stop-color="${t.cobalt}" stop-opacity="${t.glow}"/><stop offset="1" stop-color="${t.cobalt}" stop-opacity="0"/></radialGradient>
<filter id="soft" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="7"/></filter>
<style>${style}
</style>
</defs>
<rect width="${W}" height="${H}" rx="14" fill="${t.page}"/>
<g clip-path="url(#page)">
<rect width="${W}" height="${H}" fill="url(#grid)" opacity="${t.gridOpacity}"/>
<rect width="${W}" height="${H}" fill="url(#lift)"/>
</g>
${frame}
${top}
${left}
${right}
${flow}
${gates}
</svg>
`
}

// ---------------------------------------------------------------------------------------------------------
// The six module keys: small plates that link to the README's module sections.
// ---------------------------------------------------------------------------------------------------------

const KW = 400
const KH = 232
const MODULES = [
  { id: 'swarm', index: '01', word: 'SWARM', sub: 'orchestration: true', tone: 'opus',
    icon: (c, t) => `<path d="M0 -26L12 -19V-5L0 2L-12 -5V-19Z" fill="none" stroke="${c}" stroke-width="2.4"/><path d="M0 2V12M-26 22V12H26V22" fill="none" stroke="${t.edge}" stroke-width="2"/><rect x="-33" y="22" width="14" height="14" fill="${c}" fill-opacity=".25" stroke="${c}" stroke-width="2"/><circle cx="26" cy="29" r="7" fill="${c}" fill-opacity=".25" stroke="${c}" stroke-width="2"/><circle cx="0" cy="-12" r="3.4" fill="${c}"/>` },
  { id: 'flow', index: '02', word: 'FLOW', sub: '/cockpit flow', tone: 'sonnet',
    icon: (c, t) => `<circle cx="-30" cy="4" r="7" fill="${c}"/><path d="M-18 1H-8M-18 7H-8" stroke="${c}" stroke-width="2.2" stroke-dasharray="2 4" stroke-linecap="round"/><path d="M0 -6l10 10l-10 10l-10 -10z" fill="${c}"/><path d="M14 7H24" stroke="${t.steel}" stroke-width="2.2" stroke-dasharray="2 4" stroke-linecap="round"/><circle cx="32" cy="4" r="6.5" fill="none" stroke="${t.steel}" stroke-width="2"/>` },
  { id: 'inspect', index: '03', word: 'INSPECT', sub: '/cockpit agents', tone: 'cobaltHi',
    icon: (c, t) => `<circle cx="0" cy="4" r="22" fill="none" stroke="${c}" stroke-width="2.4"/><path d="M0 -26V-12M0 20V34M-30 4H-16M16 4H30" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/><rect x="-5" y="-1" width="10" height="10" fill="${c}"/>` },
  { id: 'ready', index: '04', word: 'READY', sub: '/cockpit ready', tone: 'ok',
    icon: (c, t) => [0, 1, 2, 3, 4, 5].map(i => { const x = -30 + (i % 3) * 23, y = -18 + Math.floor(i / 3) * 24; return i < 4 ? `<rect x="${x}" y="${y}" width="16" height="16" fill="${c}" fill-opacity=".2" stroke="${c}" stroke-width="2"/><path d="M${x + 3.5} ${y + 8}l3.2 3.4l6 -7" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>` : `<rect x="${x}" y="${y}" width="16" height="16" fill="none" stroke="${t.steel}" stroke-width="2" stroke-dasharray="3 3"/>` }).join('') },
  { id: 'guard', index: '05', word: 'GUARD', sub: '/cockpit guard', tone: 'haiku',
    icon: (c, t) => `<path d="M0 -24L28 26H-28Z" fill="${c}" fill-opacity=".15" stroke="${c}" stroke-width="2.6" stroke-linejoin="round"/><path d="M0 -6V10" stroke="${c}" stroke-width="3" stroke-linecap="round"/><circle cx="0" cy="18" r="2.2" fill="${c}"/>` },
  { id: 'ledger', index: '06', word: 'LEDGER', sub: '/ledger  /replay', tone: 'silver',
    icon: (c, t) => `<path d="M-30 -20V30" stroke="${t.cobaltHi}" stroke-width="2.6" stroke-linecap="round"/><path d="M-20 -16H26M-20 -2H10M-20 12H26M-20 26H-2" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/><path d="M14 -9l12 7l-12 7z" fill="${t.cobaltHi}"/>` },
]

const key = (m, t) => {
  const c = t[m.tone]
  const KS = 0.82
  const KU = 7.6
  const [letters] = word(m.word, 0.56, KS)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${KW} ${KH}" width="${KW}" height="${KH}" role="img" aria-label="${m.index} ${m.word}">
<defs><clipPath id="box"><rect x="${-KS / 2}" y="${-KS / 2}" width="${4 + KS}" height="${6 + KS}"/></clipPath><style>text{font-family:${FONT};font-kerning:none}</style></defs>
<path d="M14 1H${KW - 1}V${KH - 15}L${KW - 15} ${KH - 1}H1V14Z" fill="${t.panel}" stroke="${t.edge}" stroke-width="1.5"/>
<path d="M1 44V14L14 1H52" fill="none" stroke="${c}" stroke-width="3"/>
<path d="M${KW - 1} ${KH - 48}V${KH - 15}L${KW - 15} ${KH - 1}H${KW - 52}" fill="none" stroke="${c}" stroke-width="3" opacity=".55"/>
${text(30, 52, m.index, 26, c, { weight: 700 })}
${text(30 + 26 * 0.6 * 2 + 12, 52, 'MODULE', 13, t.steel, { track: 2.4 })}
<g transform="translate(${KW - 82} 76) scale(1.25)">${m.icon(c, t)}</g>
<g transform="translate(${n(30 + (KS * KU) / 2)} ${n(120 + (KS * KU) / 2)}) scale(${KU})" fill="none" stroke="${t.ink}" stroke-width="${KS}" stroke-linecap="square" stroke-linejoin="miter">${letters}</g>
<path d="M30 186H${KW - 30}" stroke="${t.rule}" stroke-width="1.5"/>
${text(30, 210, m.sub, 17, t.steel, { track: 0.4 })}
</svg>
`
}

// ---------------------------------------------------------------------------------------------------------

const out = (rel, content) => {
  const path = join(ASSETS, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}
const written = []
for (const [name, t] of Object.entries(THEMES)) {
  written.push(out(`hero/cockpit-hero-${name}.svg`, hero(t, true)))
  for (const m of MODULES) written.push(out(`modules/${m.index}-${m.id}-${name}.svg`, key(m, t)))
}

if (process.argv.includes('--png')) {
  const work = mkdtempSync(join(tmpdir(), 'cockpit-art-'))
  const chrome = process.env.CHROME_BIN ?? 'google-chrome'
  for (const [name, t] of Object.entries(THEMES)) {
    const svg = join(work, `${name}.svg`)
    writeFileSync(svg, hero(t, false))
    const png = join(ASSETS, 'hero', `cockpit-hero-${name}.png`)
    await run(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${join(work, `profile-${name}`)}`,
      '--default-background-color=00000000', `--window-size=${W},${H}`, `--screenshot=${join(work, `${name}.png`)}`, pathToFileURL(svg).href], { timeout: 60_000 })
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(work, `${name}.png`), '-filter_complex', '[0:v]split[a][b];[a]palettegen=max_colors=255:reserve_transparent=1[p];[b][p]paletteuse=dither=none', '-frames:v', '1', '-update', '1', png], { timeout: 60_000 })
    written.push(png)
  }
  rmSync(work, { recursive: true, force: true })
}
for (const path of written) console.log(`${path.replace(ROOT + '/', '')}: ${statSync(path).size} bytes`)
