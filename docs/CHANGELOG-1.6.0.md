# Changelog 1.6.0 — Non-cash costs, favour signals and dialogue performances

Released: 2026-11-23

Two gaps from M2 are closed: a service can now be paid with something that is **not** a
deductible item, and a defeat event can perform a **dialogue scene** instead of only
adjusting numbers.

## 1. Non-cash payment (cost receipts)

Every `cost` / `tuition` block now accepts receipts in addition to gold and items:

```json
{
  "tuition": {
    "signal": "mira_favor_paid",
    "flag": "debt_settled",
    "questKey": "help_borin",
    "manual": false,
    "autoApprove": true
  }
}
```

| Field | Meaning |
|---|---|
| `gold` / `items` | deducted on apply (unchanged) |
| `signal` | satisfied when `signal:<name>` was received; **one-shot**, consumed on apply |
| `flag` | satisfied when `flag:<name>` is set |
| `questKey` | satisfied when the quest is `completed` / `turned_in` |
| `manual` | no receipt required; the approver's judgement is the receipt |
| `autoApprove` | `false` keeps a released proposal in the queue instead of settling it automatically |

How a signal arrives:

```http
POST /api/plugins/strpg/campaigns/:id/bridge/signals/mira_favor_paid
{ "note": "Recovered the sigil for her" }
```

- the variable `signal:mira_favor_paid` is written and `signal.received` is logged;
- every pending proposal whose requirement lists that signal is released and settled
  (numeric payment still checked), unless its cost sets `autoApprove: false`.

The chat can send the receipt too, via the `strpg_receive_signal` tool, and events can do
it with the `set_signal` action.

**Manual fallback.** If a receipt is missing, `Approve` returns `409 AWAITING_SIGNAL`;
the bridge panel then offers **Manual release**, which asks for a written reason and
re-approves with `overrideReason`. The reason is stored in `bridge_apply_log` and the
proposal summary. A missing gold/item balance is still a hard failure.

## 2. Dialogue performances from events

New event action:

```json
{ "type": "dialogue", "npcKey": "elder_mira", "npcName": "Elder Mira",
  "text": "Elder Mira is waiting at the shrine steps when you limp back...",
  "lines": ["optional extra lines"] }
```

It queues a `performance` candidate instead of writing state. Approving it returns
`{ target: "chat.performance", npcKey, npcName, text, lines }`; the extension appends the
line to the current chat as an NPC/narrator message through `addOneMessage` and saves the
chat. Nothing is generated automatically — the approved performance is inserted as-is.

The seeded `defeat_at_shrine` event now demonstrates the full pattern: relationship −1,
memory candidate, notice, and a Mira dialogue performance.

## 3. Other changes

- Event action `set_signal` (records a receipt from a scene event).
- Tool `strpg_receive_signal`; the injected `STRPG_CONTEXT` prompt explains receipts.
- Bridge panel: "needs receipt" badge, waiting-receipt list, Manual release button, and a
  signal receipt input for manual testing.
- `costSchema` validates all new fields; existing content without them is unchanged.

## 4. Tests

`tests/social.test.js` grew to 13 cases: signal-gated tuition (blocked → signal → released
and consumed), manual release with audit reason, defeat dialogue performance queued and
approved, and `set_signal` from events. Suite total: **61**.

## Upgrade notes

1. Restart SillyTavern; no schema change, no new dependency.
2. Existing campaigns keep their NPC data. Add the new cost fields in Studio → Workbench
   (or publish a new version) to use them.
3. `dialogue` performances only render when a chat is open; otherwise approval still
   succeeds and the text is returned to the caller.
