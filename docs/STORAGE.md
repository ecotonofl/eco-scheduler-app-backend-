# Persistent storage and rollout

This branch is a review candidate. It has not migrated or backed up production data.
The current local SQLite file on the Render service is ephemeral. Buying extra frontend hosting or ChatGPT storage does not fix this database. A paid Render service with an attached persistent disk is one compatible option for this single-instance SQLite implementation. Multiple API instances require a different database architecture.

## Before changing the existing service

1. Pause API changes and writes during migration. Export a verified database backup from the running service BEFORE attaching a disk or triggering any deployment. Adding a disk itself triggers a deployment, so copying afterwards can be too late. If data has already disappeared, this code cannot reconstruct it.
2. From the current service shell, use a SQLite-aware backup (`sqlite3 schedule.db 'VACUUM INTO ...'`) or the `scripts/database.js backup` utility from this branch if available. Transfer the snapshot to private, durable storage outside the service, verify it, and record counts. Never upload business databases to this public repository.
3. Confirm the service has a paid plan that permits persistent disks. Attach a disk at `/var/data` through the existing service's Render settings. This document does not purchase, provision or apply that disk.
4. Restore the verified snapshot to `/var/data/schedule.db` before starting the new API. Set `NODE_ENV=production`, `PERSISTENT_DATA_DIR=/var/data`, `DB_FILE=/var/data/schedule.db`, `STORAGE_READY=1`. The disk directory must already exist. `STORAGE_READY` is an operator acknowledgement, not proof of an attached disk: verify the actual Render Disk page/mount before setting it. Do not set `ALLOW_NEW_DATABASE` during a restoration.
5. For a genuinely new empty install only, temporarily set `ALLOW_NEW_DATABASE=1`. Remove it after successful initialization. Production does not seed demo records. Missing database or storage settings fail startup instead of silently replacing records.
6. Merge/deploy backend only after review and storage is ready; it makes an additive schema migration and saves a SQLite snapshot before upgrading an existing tasks table. Check row counts, dates, times and new relationships. Deploy the companion frontend only after API verification. This workspace still lacks user authentication/roles: use isolated synthetic-data staging until access control is added before real client or invoice data.
7. Perform a controlled restart and verify records still exist at the configured disk path. Keep one instance: a Render disk is attached to a single service and does not support multi-instance scaling.

## Back up and recover

Run from the disk-backed service runtime (not a pre-deploy hook or one-off job):

```bash
npm run db:backup -- /var/data/schedule.db /var/data/backups/schedule-20261007.db
```

This generates a consistent SQLite snapshot, checks integrity and foreign keys, and refuses to overwrite an existing backup. Copy successful backups to separately protected off-service storage on a documented cadence and exercise restore drills. Same-disk backups do not protect against disk loss. The included script is a manual utility, not an automatic external backup service.

Restore while the API is stopped, to a NEW path:

```bash
npm run db:restore -- /private-backups/schedule-20261007.db /var/data/restored-schedule.db
```

Verify counts and relationships, then change `DB_FILE` to that restored path and start the API. Keep the original file untouched. Never copy an actively written SQLite file with a plain file copy, overwrite a live DB, or restore an older schema after storing new workspace data. Migrations are forward-only; rollback requires restoring a verified snapshot made before migration plus the matching application version.

## Sources checked October 7, 2026

- Render persistent disks: https://render.com/docs/disks (paid services, `/var/data`, runtime-only mount, adding a disk triggers deployment).
- SQLite `VACUUM INTO`: https://www.sqlite.org/lang_vacuum.html (consistent snapshot, original database unchanged).

No pricing or purchase recommendation is included. Confirm the account's current plan and storage choices before purchase.
