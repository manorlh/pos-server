"""
The notification service ("שירות הודעות", docs/SPEC_NOTIFICATIONS_CLUB.md part ב).

* `phone`      — E.164 inside, the provider's format at the edge; masking; keyed hash.
* `crypto`     — encryption at rest (the payment-secrets Fernet key) and keyed hashes.
* `secrets`    — the 019 token: write-only, encrypted, never returned.
* `templates`  — built-in bodies, the strict renderer, Draft → Approved → Active.
* `adapter019` — the 019 contract as documented; mock / test / live gates.
* `service`    — enqueue (dedupe, TTL, priority, suppression), resend, cancel, status.
* `outbox`     — consumption of `outbox_events` (ReadyForPickup → OrderReady SMS).
* `worker`     — lease, send, retries with backoff + jitter, reconciliation, DLR polling.
"""
