# v0.5.5: verified notification transport

v0.5.4 could repeat an alert but could not say whether any alert reaches the person. This release adds a test the person asks for and a confirmation only the person can give. The policy is `hooks/transport.ts` (pure); `hooks/register.tsx` owns the host calls and the two commands.

## States

`NOT TESTED` → `ATTEMPTED` (the host did not report writing it) or `SENT` (the host named the channel it wrote to) → `USER CONFIRMED` (the person typed `/cockpit guard seen`). There is no delivered state. A confirmation is a person's statement in one session; it is not proof that a later alert will be seen.

## Design

- **Apart from alerts.** Tests live in their own session-state key (`guard-transport`), never in the Run Ledger's alert records, and never read or write the alert state (`guard-state`). So they cannot spend the alert budget, start a cooldown, acknowledge an alert, or be mistaken for an incident.
- **The code.** The notification carries four characters from an unambiguous alphabet, drawn from the host's web crypto (the clock if it has none). It is shown in the notification and nowhere else, not in any command output, so typing it back means the text was read. A bell-only channel shows no text; `seen` without a code is accepted and kept as `no-code`.
- **Scope.** Each test holds the session id and a connection kind: `ssh` when `SSH_CONNECTION` or `SSH_TTY` is set for the process, else `local`. Only set-or-not is kept. Counting, status and confirmation use only this session's tests; a confirmation made on another connection kind is shown as not applying.
- **Limits.** One test per 30 s and six per session; a confirmation within 10 minutes; eight tests held. A clock that goes backwards waits or expires rather than passing.
- **Sound.** Requested with `test sound`, or implied by `guardSound`. It reuses `sound()` and is not waited for; the test reads `pending` until a player answers, then `sound`, `bell` or `none`.
- **Authority.** `test` and `seen` are refused unless typed by a person (composer or bridge), like `ack` and `silence`.

## What was investigated, and what was not observed

From the host's own declarations (Claude Code 2.1.296, `UiNotifyResult`):

- The channels are `iterm2`, `iterm2_with_bell`, `kitty`, `ghostty` and `terminal_bell`. `terminal_bell` rings and shows neither text nor title.
- When nothing is sent the reason is `disabled`, `no-channel` (the automatic setting found no terminal that notifies), `no-surface` or `refused`.
- `isSent: true` is the host having written the sequence or bell. A terminal that drops it, or a system that mutes banners, still reads true.

Consequences, stated as expectations and not as observations:

- **Fedora KDE (Konsole), native.** Konsole is not one of the host's notifying terminals, so the expectation is `no-channel` under the automatic setting and the bell with `preferredNotifChannel: terminal_bell`. What Konsole does on a bell is its own profile setting. Not observed.
- **Claude Code in Boat over SSH.** The host writes to the remote terminal stream; the sequence or bell is carried to the local terminal, which decides. The alert sound plays on the Boat machine, so only the bell can reach the operator. Not observed.
- **Disconnect and reconnect.** The process, its environment and the session id do not change when a connection is re-established to a surviving session, so a reconnect cannot be detected. A notification written while disconnected is lost or buffered by whatever holds the session. The output tells the operator to test again after reconnecting. Not observed.

No KDE popup process, service, tunnel or credential was added.

## Operator checklist

Run each of these where you actually work. Type the commands yourself.

Fedora, native terminal:
1. `/cockpit guard` — expect `TRANSPORT: NOT TESTED`.
2. `/cockpit guard test sound` — note the line it prints (`SENT via …`, or `ATTEMPTED … no-channel`).
3. If you see a popup with a code: `/cockpit guard seen <code>`. If you only hear or see a bell: `/cockpit guard seen`. If nothing happens, do not confirm.
4. If it said `no-channel`, set Claude Code's `preferredNotifChannel` to `terminal_bell`, restart, and repeat from step 2. Check your terminal profile's bell setting.
5. `/cockpit doctor` — the Cobalt Guard section should show `TRANSPORT: USER CONFIRMED` and no transport warning.

Boat over SSH:
1. Repeat steps 1–3 inside the SSH session. Expect `connection: SSH`. The sound plays on Boat, so judge only the popup or bell at your desk.
2. Disconnect, reconnect to the same session, and run `/cockpit guard test` again. An earlier confirmation still shows; treat only the new test as evidence.
3. With the terminal unfocused or minimised, run one more test: this is the case a real alert meets.

Then, with `guardAlerts` and `guardRepeat` on, block a task once and check that the real alert and its reminder arrive the same way.

## Tests

`tests/transport.test.ts`: code and message shape; the four states; rate limit; confirmation rules (none, not sent, wrong or malformed code, expired, backwards clock, other session, other connection kind, duplicate, older code); diagnostics wording; malformed stored state; the command end to end; person-only; sound not requested, played, bell, none, muted, off, failing, hanging; new session; hot reload; SSH; independence from the alert budget, cooldown, records, gates and reminders.

No automated test here shows that a person saw or heard anything. Real-terminal acceptance is NOT VERIFIED until the checklist is run.
