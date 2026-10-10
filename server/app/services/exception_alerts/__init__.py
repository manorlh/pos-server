"""
"יומן חריגות" (the exceptions log) and "התראות SMS על חריגות" (SMS alerts on exceptions).

* `catalog`  — every exception kind the system detects: Hebrew label, severity, what
               it is measured in (an amount, a percent), where it comes from.
* `sources`  — the detection points: each source model and how one of its rows becomes
               a log entry (idempotent per source event).
* `hooks`    — the ORM session hooks that record new source rows after their commit,
               never failing the request that wrote them.
* `log`      — writing / acknowledging entries, the short code for the SMS link.
* `rules`    — validating an alert rule (kinds, thresholds, recipients, quiet hours).
* `messages` — the SMS texts (pure, ≤ 160 characters where possible).
* `sms`      — the provider abstraction: `DryRunSmsProvider` (the default — nothing
               leaves the server) and `NotificationQueueSmsProvider` (the 019 queue,
               only when configured).
* `engine`   — matching an entry against the rules: thresholds, "N in M minutes",
               quiet hours, the per-rule rate limit, the digest, the test message.
"""
