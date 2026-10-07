# EcoGo API

This review increment connects projects, scheduled stops, samples, tests and itemized invoices in SQLite. Existing stops can remain standalone. See [workspace API and scope](docs/WORKSPACE.md) and [persistent storage, migration and recovery](docs/STORAGE.md).

## Local development

```bash
npm ci
DB_FILE=./schedule.db npm start
npm test
```

Use synthetic records. No demo rows are seeded unless explicitly setting `SEED_DEMO=1` in local development. Dates and time-of-day fields are interpreted in America/New_York. Production must use the explicit persistent-storage settings in `.env.example`; missing settings/database fail startup.

The tests use temporary SQLite files and a local HTTP listener. They validate nested ownership and foreign keys, a complete project/sample/test/invoice workflow, transactional invoice rollback, concurrent writes, legacy-stop migration, restart persistence, verified backup/restore and startup configuration guards. They never call production.

Authentication and role permissions are not included yet. Do not expose this API with real private client or billing data until those controls are implemented. Backups and documents must remain outside the public repository.
