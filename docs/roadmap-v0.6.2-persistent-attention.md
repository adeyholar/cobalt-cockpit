# Planned for v0.6.2: Persistent Attention

Status: approved for the roadmap, not designed in detail and not implemented. Nothing here is part of v0.6.1, and v0.6.1's scope was not widened for it. It is a milestone of its own, separate from [Diff-Aware Verification](roadmap-v0.7.0-diff-aware-verification.md).

## Objective

Extend the alert digest with a distinct section for incidents that a person has acknowledged and whose underlying conditions are still demonstrably open.

Today an acknowledgment takes an incident out of what the digest asks attention for. That is right for the notification and can be wrong for the condition: a verification that still fails or a hold that still stands is no less open because someone has seen the alert about it.

## Three things that stay distinct

1. **Acknowledging a notification**: a person said they received it.
2. **Viewing an occurrence**: it was shown in a look a person made.
3. **Resolving the underlying condition**: the condition the alert was about no longer holds.

The first two are records about a person's attention. Only the third is a fact about the work. No part of this milestone may let one stand in for another, in what is stored or in what is displayed.

## What the section shows

- Acknowledged incidents whose condition is observed to be open now, kept apart from the unacknowledged ones and from history.
- Severity and counts.
- Useful context, bounded: enough to tell which condition it is, within the existing limits on what an alert may carry.

## Constraints

- **Evidence that a condition is open must be current.** A historical record alone is not proof that its condition is open now in another session. An incident enters this section only where its condition can be observed to hold; where it cannot be observed, it is not listed as open, and the digest says that it is unknown rather than guessing either way.
- **No repeated desktop notifications.** An acknowledged incident that is still open is shown in the digest. It is not sent, played or rung again because it is still open.
- **The digest stays read-only.** Producing or displaying it changes no acknowledgment, no verification state and no release state, and marks nothing as seen that the existing rules would not mark.
- No change to what an acknowledgment means, to who may acknowledge, or to the conditions that raise an alert.

## To settle in design, before any code

- Which conditions can be observed as currently open from the session that draws the digest, and which are only knowable in the session that raised them.
- How the section words an incident whose condition cannot be observed from here.
- How the section relates to the existing "since last look" summary and to record-only mode, so that neither double-counts.
- The bounds: how many incidents, how much context each, and what is said when the bound is reached.

## Acceptance criteria

- The digest shows acknowledged-and-still-open incidents in a section of their own, with severity and counts.
- An acknowledgment, a view and a resolution remain three separate facts in storage and on screen.
- No incident is shown as open on the strength of a stored record alone.
- Drawing the digest writes nothing that changes acknowledgment, verification or release state.
- No notification is repeated for an acknowledged incident.
- Earlier alert histories load unchanged.
