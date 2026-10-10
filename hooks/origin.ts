// Who may change Cockpit's state by command. A closed allow-list: the person's
// own Enter, the Remote Control bridge and the SDK host's turn (the documented
// operator channels). Every other origin — a plugin, a trigger, a peer, a
// channel, or a kind a later host adds — is refused. The check reads the
// engine-stamped `kind`, never text.

export const PERSON_ORIGINS: readonly string[] = ['composer', 'bridge', 'sdk']

export const isPersonOrigin = (origin: unknown): boolean =>
  typeof origin === 'object' && origin !== null && PERSON_ORIGINS.includes((origin as { kind?: unknown }).kind as string)
