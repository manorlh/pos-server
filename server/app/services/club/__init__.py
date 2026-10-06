"""
The customer club ("מועדון לקוחות", docs/SPEC_NOTIFICATIONS_CLUB.md part ג).

* `scope`        — which club serves a company / shop; dashboard scope checks; audit.
* `otp`          — the locally managed OTP (hash only, 5 min, 5 attempts, 60 s resend,
                   server throttles), bound to purpose, club, phone and browser session.
* `registration` — the atomic sign-up after a verified OTP: customer + membership +
                   consent events + one sign-up benefit, all by unique keys.
* `public`       — what the public landing page may see (no ids of other entities).
* `lookup`       — the till's minimal member lookup by phone or member QR.
* `sale_link`    — the customer / membership a sale was made for.
* `admin`        — the dashboard's club settings, documents, QR sources and members.
"""
