// A LOCAL APPROXIMATION of the Anthropic Plugin Directory's capability-inspection guidance. It is not the Directory's
// validator and its result proves nothing about the Directory's verdict. The guidance, as the Directory states it:
//   "Write each call on the capability object as $noun.method(...), each registration as on('event', hook) on a line of
//    its own, and pass $ or on function only as one whole argument to a function declared at the top of the same file."
// This script reads a module with the TypeScript compiler API and reports every use of `$` or `on` that is not one of:
//   - `$.noun.method(...)` (a call on the capability object itself);
//   - `$` as one whole argument of a call to a function declared at the top level of the same file (or to the host's own
//     `read` / `update` imported from 'claude-code'), where that call is not itself inside the arguments of a call to a function
//     the file imports or the language provides: such a call is hoisted into its own statement first;
//   - `on('event', hook)` as a statement on a line of its own (optionally followed by a chained `.catch(...)`);
//   and every binding that shadows `$`, `on`, or a function that `$` is passed to.
// What it does not check: closures that capture `$` and are handed to Promise methods or timers (the host's own validator
// follows those), anything about types, and anything the Directory checks that is not in the sentence above.
// Usage: node scripts/check-capability-shape.mjs <file> [--typescript <path to typescript/lib/typescript.js>]
// Exit 0: no finding. Exit 1: findings (printed as file:line:column and the reason). Exit 2: could not run.
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const selfTest = args.includes('--self-test')
const file = args.find(a => !a.startsWith('--') && a !== args[args.indexOf('--typescript') + 1])
const tsIdx = args.indexOf('--typescript')
const tsPath = tsIdx >= 0 ? args[tsIdx + 1] : undefined
if (!file && !selfTest) { console.error('usage: check-capability-shape.mjs <file> | --self-test [--typescript <path>]'); process.exit(2) }
let ts
try {
  const require = createRequire(import.meta.url)
  ts = require(tsPath ?? 'typescript')
} catch (e) {
  console.error(`check-capability-shape: cannot load TypeScript (${e.message}). Run through: npm exec --yes --package=typescript@5.9.3 -- node scripts/check-capability-shape.mjs <file> --typescript "$(npm root)/typescript"`)
  process.exit(2)
}
const scan = (path, file, text) => {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

  // the functions declared at the top level of the file
  const local = new Set()
  const localDecl = new Map() // name -> the identifier of its top-level declaration
  for (const st of source.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) { local.add(st.name.text); localDecl.set(st.name.text, st.name) }
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) { local.add(d.name.text); localDecl.set(d.name.text, d.name) }
    }
  }
  // the file's own functions that `$` or `on` is passed to, filled while the uses are checked
  const passedTo = new Set()
  // functions the host's own package provides (`import { read, update } from 'claude-code'`): the documented way to pass `$`
  const hostApi = new Set()
  for (const st of source.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && /^claude-code(\/|$)/.test(st.moduleSpecifier.text) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)) {
      for (const el of st.importClause.namedBindings.elements) hostApi.add(el.name.text)
    }
  }
  const isKnown = n => n !== null && (local.has(n) || hostApi.has(n))
  const findings = []
  const at = node => { const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source)); return `${file}:${line + 1}:${character + 1}` }
  const report = (node, why) => findings.push(`${at(node)}  ${why}`)
  const transparent = n => ts.isParenthesizedExpression(n) || ts.isAwaitExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n)
  const calleeName = call => (ts.isIdentifier(call.expression) ? call.expression.text : null)

  const check = (id, name) => {
    // `$.something` or `on.something`: a use of the object itself
    const parent = id.parent
    if (ts.isPropertyAccessExpression(parent) && parent.expression === id) {
      if (name === '$') return
      return report(id, `\`${name}\` is used with a property access, not as a registration`)
    }
    if (ts.isElementAccessExpression(parent) && parent.expression === id) return report(id, `\`${name}\` is accessed dynamically`)
    if (ts.isParameter(parent) || ts.isBindingElement(parent)) return // the declaration of the parameter itself
    if (ts.isPropertyAssignment(parent) && parent.name === id) return
    if (ts.isShorthandPropertyAssignment(parent)) return report(id, `\`${name}\` is placed in an object literal`)
    if (name === 'on' && ts.isCallExpression(parent) && parent.expression === id) {
      // a registration: must be a statement of its own, with a literal event name
      let stmt = parent
      while (stmt.parent && (ts.isPropertyAccessExpression(stmt.parent) || ts.isCallExpression(stmt.parent) || ts.isAwaitExpression(stmt.parent) || ts.isParenthesizedExpression(stmt.parent))) stmt = stmt.parent
      if (!ts.isExpressionStatement(stmt.parent)) return report(id, 'an `on(...)` registration is not a statement of its own')
      const first = parent.arguments[0]
      if (!first || !(ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) return report(id, 'the event name of an `on(...)` registration is not a string literal')
      const startLine = source.getLineAndCharacterOfPosition(stmt.parent.getStart(source)).line
      const lineStart = source.getPositionOfLineAndCharacter(startLine, 0)
      const before = source.text.slice(lineStart, stmt.parent.getStart(source))
      if (before.trim() !== '') return report(id, 'an `on(...)` registration shares its line with other code')
      return
    }
    // a bare use: climb through transparent wrappers to the construct that holds it
    let node = id
    while (node.parent && transparent(node.parent)) node = node.parent
    const holder = node.parent
    if (ts.isCallExpression(holder) && holder.arguments.includes(node)) {
      const name0 = calleeName(holder)
      if (!isKnown(name0)) return report(id, `\`${name}\` is passed to ${name0 === null ? 'a call the file does not declare' : `\`${name0}\`, which is not declared at the top level of this file`}`)
      if (local.has(name0) && !hostApi.has(name0)) passedTo.add(name0)
      // a file's own helper that receives `$` is hoisted into its own statement, not nested in the arguments of another call
      // (the host's `read` and `update` are the documented way to pass `$` and may sit anywhere)
      if (!local.has(name0) || hostApi.has(name0)) { shadowCheck(id, name, name0); return }
      for (let up = holder.parent; up; up = up.parent) {
        if (ts.isCallExpression(up)) {
          const inArgs = up.arguments.some(a => a.pos <= holder.pos && holder.end <= a.end)
          if (inArgs) {
            const n = calleeName(up)
            // a wrapper declared in this file (such as `hush(() => helper($))`) is the supported way to guard a call
            if (!(n !== null && local.has(n))) return report(id, `\`${name}\` is passed to \`${name0}\`, which sits inside the arguments of \`${n ?? 'a call the file does not declare'}\`: hoist the call into its own statement`)
          }
        }
        // the walk ends at the function that holds the statement: a closure handed to another call is judged by what it contains
        if (ts.isArrowFunction(up) || ts.isFunctionExpression(up) || ts.isFunctionDeclaration(up) || ts.isMethodDeclaration(up)) break
      }
      shadowCheck(id, name, name0)
      return
    }
    report(id, `\`${name}\` is used as ${ts.SyntaxKind[holder?.kind ?? 0]} (a bare use that is not one whole argument of a call)`)
  }
  // a name given to `$`, `on` or a function `$` is passed to must not be declared again in a scope between the use and the top
  const declares = (scopeNode, wanted) => {
    const out = []
    const params = ts.isFunctionLike(scopeNode) ? scopeNode.parameters : []
    for (const p of params) if (ts.isIdentifier(p.name) && p.name.text === wanted) out.push(p)
    const body = ts.isBlock(scopeNode) ? scopeNode.statements : []
    for (const st of body) if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === wanted) out.push(d)
      if (ts.isObjectBindingPattern(d.name) || ts.isArrayBindingPattern(d.name)) for (const el of d.name.elements) if (ts.isBindingElement(el) && ts.isIdentifier(el.name) && el.name.text === wanted) out.push(el)
    }
    return out
  }
  function shadowCheck(id, name, callee) {
    for (const wanted of new Set([name, callee])) {
      if (wanted === undefined || wanted === null) continue
      for (let up = id.parent; up && up !== source; up = up.parent) {
        if (!(ts.isBlock(up) || ts.isFunctionLike(up))) continue
        const found = declares(up, wanted).filter(d => d !== id && d !== id.parent)
        if (found.length > 0 && !(wanted === name && ts.isFunctionLike(up) && found.every(f => ts.isParameter(f)))) return report(id, `\`${wanted}\` is declared again inside the scope of this use (${at(found[0])}): the declaration hides the one the scan follows`)
      }
    }
  }
  const isRegistrationFile = source.statements.some(st => ts.isImportDeclaration(st) && /claude-code/.test(st.moduleSpecifier.text) && /\bOn\b/.test(st.getText(source)))
  const visit = node => {
    if (ts.isIdentifier(node) && (node.text === '$' || (node.text === 'on' && isRegistrationFile))) {
      // skip declarations of the name (parameters named `$`), type positions, and property names
      const p = node.parent
      const isDecl = (ts.isParameter(p) && p.name === node) || (ts.isVariableDeclaration(p) && p.name === node) || (ts.isBindingElement(p) && p.name === node)
      const isName = (ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.name === node) || (ts.isTypePredicateNode?.(p)) || ts.isTypeReferenceNode(p) || (ts.isMethodSignature(p)) || (ts.isPropertySignature(p) && p.name === node)
      const isImport = ts.isImportSpecifier(p) || ts.isImportClause(p)
      if (!isDecl && !isName && !isImport) check(node, node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  // File-wide, whatever the scope: a function `$` or `on` is passed to is bound once, at the top level, and in a registration
  // file nothing but a parameter is named `on`. The Directory reported a second binding in a sibling scope (v0.6.4: a nested
  // `ask` beside the top-level `ask` dialog helper; v0.5.3: `on` destructured in a callback), which the walk above, limited to
  // the scopes around a use, does not reach.
  const isBindingName = node => {
    const p = node.parent
    return (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p) || ts.isEnumDeclaration(p) || ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) && p.name === node
  }
  const rebinds = node => {
    if (ts.isIdentifier(node) && isBindingName(node)) {
      const name = node.text
      if (passedTo.has(name) && node !== localDecl.get(name)) report(node, `\`${name}\` is declared again here, while \`$\` or \`on\` is passed to the top-level \`${name}\` (${at(localDecl.get(name))}): a second binding of that name, in any scope, hides which one receives it`)
      else if (name === 'on' && isRegistrationFile && !(ts.isParameter(node.parent) && ts.isIdentifier(node.parent.name))) report(node, '`on` is bound here by something other than a parameter: in a registration file the name belongs to the registration function')
    }
    ts.forEachChild(node, rebinds)
  }
  rebinds(source)
  return findings
}
// --self-test: the cases that pin what the check reports, run in this process on sources written here
const HEAD = "import type { On } from 'claude-code'\nimport { read } from 'claude-code'\nimport { outside } from './other'\n"
const CASES = [
  ['the v0.5.9 blocker\'s shape: a helper given $ inside an imported function\'s arguments', `${HEAD}const helper = async ($) => 1\nconst bad = async ($) => outside(await helper($))\n`, true],
  ['the same call hoisted into its own statement', `${HEAD}const helper = async ($) => 1\nconst good = async ($) => {\n  const x = await helper($)\n  return outside(x)\n}\n`, false],
  ['$ passed to an imported function', `${HEAD}const bad = async ($) => outside($)\n`, true],
  ['the host\'s own read inside an imported function\'s arguments', `${HEAD}const atomA = 1\nconst good = async ($) => outside(await read($, atomA))\n`, false],
  ['a direct capability call anywhere', `${HEAD}const good = async ($) => outside(await $.store.keys())\n`, false],
  ['a dynamic access on $', `${HEAD}const a = async ($) => $['store'].keys()\n`, true],
  ['$ bound to another name', `${HEAD}const b = async ($) => { const alias = $; return alias }\n`, true],
  ['$ in an object literal', `${HEAD}const c = async ($) => ({ $ })\n`, true],
  ['a helper name declared again where $ is passed to it', `${HEAD}const helper = async ($) => 1\nconst worse = async ($) => {\n  const helper = (y) => y\n  const z = await helper($)\n  return z\n}\n`, true],
  ['the v0.6.4 shape: a helper $ is passed to, declared again in a sibling function', `${HEAD}const helper = async ($) => 1\nconst other = async (x) => {\n  const helper = (y) => y\n  return helper(x)\n}\nconst uses = async ($) => {\n  const z = await helper($)\n  return z\n}\n`, true],
  ['a helper $ is passed to, whose name is only a property name elsewhere', `${HEAD}const helper = async ($) => 1\nconst o = { helper: 1 }\nconst uses = async ($) => {\n  const z = await helper($)\n  return z + o.helper\n}\n`, false],
  ['the v0.5.3 shape: on destructured in a callback beside the registrations', `${HEAD}export const register = (on) => {\n  const kept = [['a', true]].filter(([key, on]) => key !== '')\n  on('session.start', async ($, e, next) => next(e))\n  return kept\n}\n`, true],
  ['a helper that takes on as a plain parameter', `${HEAD}const wire = (on) => {\n  on('session.start', async ($, e, next) => next(e))\n}\nexport const register = (on) => {\n  wire(on)\n}\n`, false],
  ['a registration with a literal event on its own line', `${HEAD}export const register = (on) => {\n  on('session.start', async ($, e, next) => next(e))\n}\n`, false],
  ['a registration whose event is not a literal', `${HEAD}const ev = 'session.start'\nexport const register = (on) => {\n  on(ev, async ($, e, next) => next(e))\n}\n`, true],
  ['a registration sharing its line', `${HEAD}export const register = (on) => {\n  const x = 1; on('session.start', async ($, e, next) => next(e))\n}\n`, true],
]
if (selfTest) {
  let bad = 0
  for (const [name, text, expected] of CASES) {
    const got = scan(`/self-test/${name.replace(/\W+/g, '-')}.tsx`, 'self-test', text).length > 0
    console.log(`${got === expected ? 'ok  ' : 'FAIL'} ${expected ? 'reported' : 'passes  '}: ${name}`)
    if (got !== expected) bad++
  }
  console.log(`check-capability-shape self-test: ${CASES.length - bad} of ${CASES.length} as expected`)
  process.exit(bad === 0 ? 0 : 1)
}
const path = resolve(file)
if (!existsSync(path)) { console.error(`check-capability-shape: no such file: ${file}`); process.exit(2) }
const findings = scan(path, file, readFileSync(path, 'utf8'))
for (const f of findings) console.log(f)
console.log(`check-capability-shape: ${findings.length} finding${findings.length === 1 ? '' : 's'} in ${file} (a local approximation, not the Directory's validator)`)
process.exit(findings.length === 0 ? 0 : 1)
