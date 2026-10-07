import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'node:path';
import { mkdir, stat, realpath } from 'node:fs/promises';

export async function databaseFilename(env = process.env) {
  const production = env.NODE_ENV === 'production' || env.RENDER === 'true';
  const filename = path.resolve(env.DB_FILE || './schedule.db');
  if (production) {
    if (!env.DB_FILE || !path.isAbsolute(env.DB_FILE) || !env.PERSISTENT_DATA_DIR || env.STORAGE_READY !== '1') {
      throw new Error('Persistent storage is required: configure an absolute DB_FILE, PERSISTENT_DATA_DIR and STORAGE_READY=1 after verifying the disk.');
    }
    const root = await realpath(env.PERSISTENT_DATA_DIR);
    const parent = await realpath(path.dirname(filename));
    if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error('DB_FILE must be inside PERSISTENT_DATA_DIR.');
    let info;
    try { info=await stat(filename); } catch (error) {
      if (error.code !== 'ENOENT' || env.ALLOW_NEW_DATABASE !== '1') throw new Error('Database is missing. Restore a verified backup, or explicitly allow first-time initialization with ALLOW_NEW_DATABASE=1.');
    }
    if (info) {
      const actual=await realpath(filename);
      if (!info.isFile() || !actual.startsWith(root + path.sep)) throw new Error('DB_FILE must be a file inside PERSISTENT_DATA_DIR.');
    }
  } else {
    await mkdir(path.dirname(filename), { recursive: true });
  }
  return filename;
}

export async function openDatabase(filename, { seedDemo = false } = {}) {
  const db = await open({ filename, driver: sqlite3.Database });
  await db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const version = (await db.get('PRAGMA user_version')).user_version;
  if (version > 1) { await db.close(); throw new Error('Database schema is newer than this application.'); }
  if (version < 1) {
    const existing = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'");
    if (existing && filename !== ':memory:') {
      const directory = path.join(path.dirname(filename), 'backups');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await db.run('VACUUM INTO ?', path.join(directory, `before-workspace-${Date.now()}.db`));
    }
    await db.exec('BEGIN IMMEDIATE');
    try {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          client TEXT NOT NULL,
          address TEXT NOT NULL DEFAULT '',
          contact_name TEXT NOT NULL DEFAULT '',
          contact_phone TEXT NOT NULL DEFAULT '',
          lab TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'Active' CHECK(status IN ('Active','On Hold','Completed')),
          notes TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT, stop_number INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'Pending', work_type TEXT NOT NULL, company TEXT NOT NULL,
          address TEXT NOT NULL, contact_name TEXT DEFAULT '', contact_phone TEXT DEFAULT '',
          instructions TEXT DEFAULT '', lab TEXT DEFAULT '', coc_link TEXT DEFAULT '', driver TEXT DEFAULT '',
          scheduled_date TEXT NOT NULL, scheduled_time TEXT DEFAULT '', arrival_time TEXT DEFAULT '',
          leaving_time TEXT DEFAULT '', miles REAL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS samples (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
          sample_id TEXT NOT NULL,
          matrix TEXT NOT NULL CHECK(matrix IN ('Groundwater','Drinking Water','Wastewater','Soil','Surface Water','Reclaimed Water')),
          status TEXT NOT NULL DEFAULT 'Planned' CHECK(status IN ('Planned','Collected','At Lab','Reported')),
          collected_date TEXT NOT NULL DEFAULT '', collected_time TEXT NOT NULL DEFAULT '',
          lab TEXT NOT NULL DEFAULT '', coc_link TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
          UNIQUE(project_id, sample_id)
        );
        CREATE TABLE IF NOT EXISTS sample_tests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sample_id INTEGER NOT NULL REFERENCES samples(id) ON DELETE RESTRICT,
          name TEXT NOT NULL, method TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'Requested' CHECK(status IN ('Requested','In Progress','Reported')),
          result TEXT NOT NULL DEFAULT '', units TEXT NOT NULL DEFAULT '', qualifier TEXT NOT NULL DEFAULT '',
          UNIQUE(sample_id, name, method)
        );
        CREATE TABLE IF NOT EXISTS invoices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
          number TEXT NOT NULL UNIQUE,
          issued_date TEXT NOT NULL, due_date TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'Draft' CHECK(status IN ('Draft','Sent','Paid','Void')),
          notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS invoice_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
          description TEXT NOT NULL,
          quantity REAL NOT NULL CHECK(quantity>0),
          unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents>=0),
          amount_cents INTEGER NOT NULL CHECK(amount_cents>=0)
        );
        CREATE INDEX IF NOT EXISTS samples_project ON samples(project_id);
        CREATE INDEX IF NOT EXISTS tests_sample ON sample_tests(sample_id);
        CREATE INDEX IF NOT EXISTS invoices_project ON invoices(project_id);
        CREATE INDEX IF NOT EXISTS items_invoice ON invoice_items(invoice_id);
      `);
      const columns = await db.all('PRAGMA table_info(tasks)');
      if (!columns.some(c => c.name === 'scheduled_time')) await db.exec("ALTER TABLE tasks ADD COLUMN scheduled_time TEXT DEFAULT ''");
      if (!columns.some(c => c.name === 'project_id')) await db.exec('ALTER TABLE tasks ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE RESTRICT');
      await db.exec('CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id); PRAGMA user_version=1; COMMIT');
    } catch (error) { await db.exec('ROLLBACK'); await db.close(); throw error; }
  }
  if (seedDemo && !(await db.get('SELECT COUNT(*) AS n FROM tasks')).n) {
    await db.run("INSERT INTO tasks (work_type,company,address,driver,scheduled_date) VALUES ('Ground Water Sampling','Demo Client','Sample address','Driver 1',?)", floridaDate());
  }
  return db;
}

export function floridaDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type).value).join('-');
}
