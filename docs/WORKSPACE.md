# Project workspace API (review candidate)

Project data connects field stops, samples/tests and invoices. Existing unlinked stops remain usable. Additive schema migration preserves IDs and scheduled times; no existing records are assigned to a project automatically.

- `GET/POST /api/projects`; `GET/PUT /api/projects/:id`
- `GET /api/projects/:id` returns project + linked tasks, samples with tests, and invoices with computed totals.
- `POST /api/projects/:id/samples`; `PUT /api/projects/:id/samples/:sampleId`
- `POST /api/projects/:id/samples/:sampleId/tests`; `PUT .../tests/:testId`
- `POST /api/projects/:id/invoices` accepts number, issue/due dates, notes and items (`description`, `quantity`, integer `unit_price_cents`). Server computes rounded line totals; client totals are ignored.
- `GET /api/projects/:id/invoices/:invoiceId`; `PUT .../status` accepts `status`.
- Invoice transitions: Draft → Sent or Void; Sent → Paid or Void. Terminal invoices are immutable. These are recordkeeping statuses only: no emails or payments are executed.
- Existing task routes accept optional `project_id`. Creating a linked stop reuses project client/address/contact/lab when omitted, while recording the stop's own snapshot. `GET /api/tasks?project_id=...` filters by project; date/driver filters still work.

Unique project code, per-project sample ID, per-sample test name/method and global invoice number avoid duplicate records. Foreign keys and nested route ownership checks prevent cross-project associations. Collection date/time are required after collection, and reported tests need a result. Results and qualifiers are stored as text for values such as `ND` or `<0.01`; the app does not determine regulatory compliance.

The next release still needs authentication/role enforcement, project document attachments, report generation, tax/discount handling, invoice editing/credit notes and audit history. Do not load real customer data into public previews. No production or hosting settings were changed by this branch.
