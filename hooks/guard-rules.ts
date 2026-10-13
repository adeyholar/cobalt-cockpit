// What a guard that fails answers. A guard that throws has not passed the call, so the answer is a refusal. These are pure
// and hold nothing of the host, so a test can make each guard fail and read the refusal.

export type GuardName = 'attribution' | 'instruction-file' | 'destructive-command' | 'tool'

/** The plugin option that switches each guard off: the operator's own control, named in the refusal. */
const GUARD_SETTING: Record<GuardName, string> = {
  attribution: '"attributionGuard"',
  'instruction-file': '"attributionGuard"',
  'destructive-command': '"blastRadiusGuard"',
  tool: '"attributionGuard" or "blastRadiusGuard"',
}

const ERROR_KINDS = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError'])

/**
 * The refusal for a guard that failed. It names the guard, the tool and the kind of error and nothing else: an error
 * message can carry the command, a path or a value, and a diagnostic must not repeat any of them.
 */
export const guardFailure = (name: GuardName, tool: string, error: unknown): { deny: string } => {
  // both are allow-listed: a name is data, and data is not repeated
  const kind = error instanceof Error && ERROR_KINDS.has(error.name) ? error.name : 'Error'
  const shown = /^(?:[A-Za-z][A-Za-z0-9]{0,30}|mcp__[A-Za-z0-9_-]{1,40}__[A-Za-z0-9_-]{1,40})$/.test(tool) ? tool : 'tool'

  return {
    deny: `Cobalt Cockpit: the ${name} guard failed (${kind}), so this ${shown} call did not run. A failed check is not a pass. Retrying the same call will be checked again; do not reach the same effect another way. If the failure persists, the person can reload the plugin or turn the guard off with the plugin option ${GUARD_SETTING[name]}; other tools are not affected.`,
  }
}

/** Runs one guard so that nothing it throws can authorize the call: a failure is a refusal. */
export const failClosed = async (name: GuardName, tool: string, run: () => Promise<{ deny: string } | null>): Promise<{ deny: string } | null> => {
  try {
    return await run()
  } catch (error) {
    return guardFailure(name, tool, error)
  }
}
