// Who may change Cockpit's state by command. A closed allow-list: the person's
// own Enter, the Remote Control bridge and the SDK host's turn (the documented
// operator channels). Every other origin — a plugin, a trigger, a peer, a
// channel, or a kind a later host adds — is refused. The check reads the
// engine-stamped `kind`, never text.

export const PERSON_ORIGINS: readonly string[] = ['composer', 'bridge', 'sdk']

export const isPersonOrigin = (origin: unknown): boolean =>
  typeof origin === 'object' && origin !== null && PERSON_ORIGINS.includes((origin as { kind?: unknown }).kind as string)

/**
 * Who may AUTHORIZE: change a hold, a trust record, a pin, a router or a task by command. Narrower than `isPersonOrigin`.
 * The host stamps `sdk` on every `claude -p` / Agent SDK turn and cannot say whether a person or an agent-controlled
 * process (a nested `claude -p` run from a tool call) started it, so `sdk` is not evidence of a person and is refused here.
 * Only the terminal's own Enter and the Remote Control bridge are attested human gestures. Fails closed for a kind a later
 * host adds. `isPersonOrigin` still decides whether a prompt may start or classify a task: that grants nothing.
 */
export const HUMAN_AUTHORITY_ORIGINS: readonly string[] = ['composer', 'bridge']

export const isHumanAuthority = (origin: unknown): boolean =>
  typeof origin === 'object' && origin !== null && HUMAN_AUTHORITY_ORIGINS.includes((origin as { kind?: unknown }).kind as string)
