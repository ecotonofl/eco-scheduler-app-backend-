import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'node:path';
import { stat, mkdir, copyFile, unlink, chmod, open as openFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { pathToFileURL } from 'node:url';

async function mustNotExist(filename) {
  try { await stat(filename); } catch(error) { if(error.code==='ENOENT')return;throw error; }
  throw new Error('Destination already exists; backups and restores never overwrite a database.');
}
export async function verifyDatabase(filename) {
  const db=await open({filename,driver:sqlite3.Database,mode:sqlite3.OPEN_READONLY});
  try {
    const check=await db.all('PRAGMA integrity_check');
    if(check.length!==1 || check[0].integrity_check!=='ok')throw new Error('Database integrity check failed');
    if((await db.all('PRAGMA foreign_key_check')).length)throw new Error('Database relationship check failed');
    if(!(await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'")))throw new Error('Not an EcoGo database');
  } finally {await db.close();}
}
export async function backupDatabase(source,target) {
  source=path.resolve(source);target=path.resolve(target);
  await stat(source);await mustNotExist(target);await mkdir(path.dirname(target),{recursive:true,mode:0o700});
  const temp=target+`.partial-${process.pid}-${Date.now()}`;
  const db=await open({filename:source,driver:sqlite3.Database,mode:sqlite3.OPEN_READONLY});
  try {
    await db.exec('PRAGMA busy_timeout=5000');await db.run('VACUUM INTO ?',temp);
    await verifyDatabase(temp);await chmod(temp,0o600);
    const file=await openFile(temp,'r');try{await file.sync();}finally{await file.close();}
    // Hard link creates the target only if it still does not exist (race-safe).
    const {link}=await import('node:fs/promises');await link(temp,target);await unlink(temp);
  } catch(error){await unlink(temp).catch(()=>{});throw error;}finally{await db.close();}
  return target;
}
export async function restoreDatabase(source,target) {
  source=path.resolve(source);target=path.resolve(target);
  await verifyDatabase(source);await mustNotExist(target);await mkdir(path.dirname(target),{recursive:true,mode:0o700});
  await copyFile(source,target,constants.COPYFILE_EXCL);await chmod(target,0o600);
  try {await verifyDatabase(target);}catch(error){await unlink(target);throw error;}
  return target;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [operation,source,target]=process.argv.slice(2);
  try {
    if(!['backup','restore'].includes(operation)||!source||!target)throw new Error('Usage: node scripts/database.js backup|restore SOURCE TARGET');
    console.log(await (operation==='backup'?backupDatabase:restoreDatabase)(source,target));
  } catch(error){console.error(error.message);process.exitCode=1;}
}
