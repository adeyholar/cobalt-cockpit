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
const file = args.find(a => !a.startsWith('--') && a !== args[args.indexOf('--typescript') + 1])
const tsIdx = args.indexOf('--typescript')
const tsPath = tsIdx >= 0 ? args[tsIdx + 1] : undefined
if (!file) { console.error('usage: check-capability-shape.mjs <file> [--typescript <path>]'); process.exit(2) }
let ts
try {
  const require = createRequire(import.meta.url)
  ts = require(tsPath ?? 'typescript')
} catch (e) {
  console.error(`check-capability-shape: cannot load TypeScript (${e.message}). Run through: npm exec --yes --package=typescript@5.9.3 -- node scripts/check-capability-shape.mjs <file> --typescript "$(npm root)/typescript"`)
  process.exit(2)
}
const path = resolve(file)
if (!existsSync(path)) { console.error(`check-capability-shape: no such file: ${file}`); process.exit(2) }
const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

// the functions declared at the top level of the file
const local = new Set()
for (const st of source.statements) {
  if (ts.isFunctionDeclaration(st) && st.name) local.add(st.name.text)
  if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) {
    if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) local.add(d.name.text)
  }
}
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
for (const f of findings) console.log(f)
console.log(`check-capability-shape: ${findings.length} finding${findings.length === 1 ? '' : 's'} in ${file} (a local approximation, not the Directory's validator)`)
process.exit(findings.length === 0 ? 0 : 1)
