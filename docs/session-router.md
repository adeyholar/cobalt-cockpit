# Session router and NobodyWho telemetry

> Part of the [Cobalt Cockpit documentation](README.md). This text was moved here from the root README when the README was restructured for v0.6.0; the wording is unchanged unless a sentence says otherwise. Overview: [Session router](../README.md#session-router). The privacy boundary of the JEV mode is also kept in the root README.

## Session router

A router is an optional, lightweight classifier that **recommends** how to handle a new task. You choose it per session:

```
/cockpit router              show the active router (and choose one, in an interactive session)
/cockpit router off          Cockpit's deterministic policy only (every new session starts here)
/cockpit router nobodywho    the local decision router, local provider only
/cockpit router jev          the same router's TypeSafe JEV provider (an external API)
```

The choice lasts for the session and is never saved. One router is active at a time, and switching discards everything the previous one said. `/cockpit` and `/cockpit version` show it: `ROUTER / OFF`, `ROUTER / NOBODYWHO · LOCAL`, `ROUTER / JEV · CONNECTED`.

What a router may do is recommend one of five routes: handle it in the main session, scout with Haiku, delegate bounded parts to Sonnet, consider a higher effort, or consider an Opus consultation. What it may not do is anything else. It never starts an agent, admits or skips an Opus consultation, or changes a model, an effort, a permission, an ownership rule or a verification gate. Cockpit's rules judge every recommendation:

- The rules go first. When they already settle the route (a mandatory consultation, or a route read off the prompt), no router is asked at all.
- A recommendation for Opus is refused unless a consultation ground already holds on evidence. You are shown a notice instead, and asking for Opus yourself is a ground the rules honour.
- An accepted recommendation adds one advisory line to the task. A scout or worker it suggests still goes through assignment and admission.
- If the router is down, slow, or its answer does not hold up, the deterministic policy decides and the fallback is recorded.

A router is asked once per task, at its start, when the rules do not settle it; never for a tool call, a helper or an Opus admission. What counts as a task: with a plan in progress, the whole plan is one task and prompts inside it are not asked about. Without a plan, each prompt you submit (of 16 characters or more) is a task of its own, so each is asked about. The question is five fixed yes/no features of the task, each asked in both orders. A feature counts only when both orders agree, and the whole reading is discarded when fewer than four of five agree or more than three are affirmed. That is what makes the answer independent of option position: the local classifiers measurably follow position otherwise.

Measured for v0.5.0 on 56 balanced synthetic tasks (details and limits in [docs/delivery-v0.5.0-router.md](delivery-v0.5.0-router.md)): the rules alone classified 45; the router's reading alone was right for 49 with the local Qwen3 4B model and 51 with JEV, and 8 with the router's 0.6B tier-1 specialist, which is why NobodyWho mode uses the router's plain local provider. With the rules going first, as shipped, the outcome was right for 47 (NobodyWho) and 46 (JEV): most of what a router adds is "this is one for Opus", which it may only tell you. JEV answered in about 250 ms per request (p50 246 ms, p95 297 ms), not the 16 ms sometimes quoted.

**JEV sends data off your machine.** In JEV mode ten small requests go to the TypeSafe API through your own decision router. They carry only words from a fixed engineering vocabulary found in the prompt that starts a task, and a size bucket: never prompt text, names, paths or numbers. A prompt in which credential-shaped text is recognised is not sent to any router. See PRIVACY.md.

```sh
# one time: a copy of your router config with JEV enabled, used by Cockpit's JEV mode only
mkdir -m 700 -p ~/.config/cobalt-cockpit/router-jev
python3 -c "import json,os;h=os.path.expanduser;c=json.load(open(h('~/.config/decision-router/config.json')));c.setdefault('jev',{})['enabled']=True;open(h('~/.config/cobalt-cockpit/router-jev/config.json'),'w').write(json.dumps(c,indent=1)+'\n')"
printf '%s\n' '{"routerConfigDir":"~/.config/cobalt-cockpit/router-jev"}' | claude plugin configure cobalt-cockpit@cobalt-cockpit --values-stdin
```

Your global router configuration is untouched, so nothing else on the machine reaches JEV. The directory must be your own: one inside the project you are working in is refused, so a repository can never choose where the router sends a request. Without `routerConfigDir`, JEV mode reports `JEV · UNAVAILABLE (jev_disabled)` whenever the router's own switch is off.

## NobodyWho integration

This section is the read-only telemetry; the router you can select is described above. By default, Cockpit checks `$XDG_STATE_HOME/decision-router/ledger.jsonl`, or `$HOME/.local/state/decision-router/ledger.jsonl`. Set `ledgerPath` to override it; set `localControl` false to stop reading.

Only `caller: "claude"` receipts arriving after startup are shown. Decision comes from an `ask` receipt; Pruning comes from a `prune` receipt. They stay separate. Missing, malformed or unavailable ledgers are silent; LOCAL CONTROL is omitted when nothing is observed. This telemetry shows no fake activity, has no cloud fallback and does not depend on local control. (JEV is reachable only as the session router you may select, described above.) Raw prompts, hidden reasoning, receipt details and credential values are not copied into this adapter's telemetry.
