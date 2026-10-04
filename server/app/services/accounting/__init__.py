"""
Accounting export (docs/ACCOUNTING_EXPORT_AND_REPORTS.md §2).

* `settings` — the account mapping, company with shop override, and what is missing.
* `journal`  — one balanced journal entry per Z (or per shop-day / shop-month).
* `movein`   — Hashavshevet `MOVEIN.DAT` + `MOVEIN.PRM` (flexible and detailed layouts).
* `excel`    — the same entries as an xlsx journal (Priority's load sheet, and a human copy).
* `exports`  — batches: selecting Zs, the re-export lock, the stored zip.
"""
