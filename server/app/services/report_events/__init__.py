"""
Temporary events ("אירועים") — docs/SPEC_EVENTS.md.

* `crud`      — the event's life: create / update / delete (draft only), the overlap rule,
                readiness and confirmation ("נותן תוקף": freeze the report, release the tills).
* `report`    — the producer report, live from the documents while draft.
* `rules`     — the insight rules (weak / idle till, high tip, refunds, exceptions, shifts…).
* `reconcile` — the event's documents against the Z reports and the card transmissions.
* `export`    — the Excel workbook.
"""
