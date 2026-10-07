import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import sqlite3 from 'sqlite3';
import {open} from 'sqlite';
import {createApp} from '../src/app.js';
import {openDatabase,databaseFilename,floridaDate} from '../src/database.js';
import {backupDatabase,restoreDatabase,verifyDatabase} from '../scripts/database.js';

async function fixture(t,filename=':memory:') {
  const db=await openDatabase(filename);const server=http.createServer(createApp(db));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await db.close();});
  const request=async(method,url,body)=>{
    const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:r.status,data:r.status===204?null:await r.json()};
  };
  return {db,request};
}
async function project(request,code='P-001') {
  const r=await request('POST','/api/projects',{code,name:'Synthetic project',client:'Sample Client',address:'Test address',contact_name:'Test Contact',contact_phone:'555-0100',lab:'Test Lab'});
  assert.equal(r.status,201);return r.data;
}
async function sample(request,p,extra={}) {
  const r=await request('POST',`/api/projects/${p.id}/samples`,{sample_id:'MW-01',matrix:'Groundwater',...extra});assert.equal(r.status,201);return r.data;
}
const invoiceBody={number:'INV-001',issued_date:'2026-10-07',due_date:'2026-11-07',items:[{description:'Sampling',quantity:2.5,unit_price_cents:9000},{description:'Mileage',quantity:10,unit_price_cents:67}]};

test('Project → scheduled stop → collected sample → reported test → invoice and payment record',async t=>{
  const {request}=await fixture(t);const p=await project(request);
  let r=await request('POST','/api/tasks',{project_id:p.id,work_type:'Ground Water Sampling',driver:'Sampler',scheduled_date:'2026-10-07',scheduled_time:'09:30'});
  assert.equal(r.status,201);assert.equal(r.data.company,p.client);assert.equal(r.data.address,p.address);assert.equal(r.data.lab,p.lab);const task=r.data;
  r=await request('PUT',`/api/tasks/${task.id}`,{status:'In Progress',arrival_time:'09:31 AM',id:999});assert.equal(r.data.id,task.id);assert.equal(r.data.scheduled_time,'09:30');
  r=await request('GET',`/api/tasks?date=2026-10-07&driver=Sampler&project_id=${p.id}`);assert.equal(r.data.length,1);assert.equal(r.data[0].project_code,p.code);
  const s=await sample(request,p);assert.equal(s.lab,p.lab);
  r=await request('PUT',`/api/projects/${p.id}/samples/${s.id}`,{status:'Collected',collected_date:'2026-10-07',collected_time:'10:00'});assert.equal(r.status,200);
  r=await request('POST',`/api/projects/${p.id}/samples/${s.id}/tests`,{name:'BTEX',method:'8260',status:'Requested'});assert.equal(r.status,201);const analysis=r.data;
  r=await request('PUT',`/api/projects/${p.id}/samples/${s.id}/tests/${analysis.id}`,{status:'Reported',result:'<0.01',units:'mg/L',qualifier:'U'});assert.equal(r.status,200);
  r=await request('POST',`/api/projects/${p.id}/invoices`,{...invoiceBody,total_cents:1});assert.equal(r.status,201);assert.equal(r.data.total_cents,23170);const invoice=r.data;
  r=await request('GET',`/api/projects/${p.id}`);assert.equal(r.data.tasks[0].scheduled_time,'09:30');assert.equal(r.data.samples[0].tests[0].result,'<0.01');assert.equal(r.data.invoices[0].total_cents,23170);
  r=await request('GET','/api/projects');assert.equal(r.data[0].stop_count,1);assert.equal(r.data[0].sample_count,1);assert.equal(r.data[0].outstanding_cents,23170);
  r=await request('PUT',`/api/projects/${p.id}/invoices/${invoice.id}/status`,{status:'Paid'});assert.equal(r.status,409);
  r=await request('PUT',`/api/projects/${p.id}/invoices/${invoice.id}/status`,{status:'Sent'});assert.equal(r.status,200);
  r=await request('PUT',`/api/projects/${p.id}/invoices/${invoice.id}/status`,{status:'Paid'});assert.equal(r.status,200);
  r=await request('GET','/api/projects');assert.equal(r.data[0].outstanding_cents,0);
  r=await request('PUT',`/api/projects/${p.id}/invoices/${invoice.id}/status`,{status:'Draft'});assert.equal(r.status,409);
});

test('Nested ownership checks and foreign keys reject orphan and cross-project associations',async t=>{
  const {db,request}=await fixture(t),p=await project(request),other=await project(request,'P-002'),s=await sample(request,p);
  assert.equal((await request('POST',`/api/projects/${other.id}/samples/${s.id}/tests`,{name:'pH'})).status,404);
  assert.equal((await request('POST','/api/tasks',{project_id:999,scheduled_date:'2026-10-07',work_type:'Tap Water Grab'})).status,404);
  let r=await request('POST',`/api/projects/${p.id}/invoices`,invoiceBody);const invoice=r.data;
  assert.equal((await request('GET',`/api/projects/${other.id}/invoices/${invoice.id}`)).status,404);
  await assert.rejects(db.run("INSERT INTO samples(project_id,sample_id,matrix) VALUES (999,'Orphan','Soil')"),/FOREIGN KEY/);
  await assert.rejects(db.run('DELETE FROM projects WHERE id=?',p.id),/FOREIGN KEY/);
});

test('Validation rejects duplicate samples, impossible dates, unsafe links and missing collection/results',async t=>{
  const {request}=await fixture(t),p=await project(request),s=await sample(request,p);
  assert.equal((await request('POST','/api/projects',{code:p.code,name:'Duplicate',client:'Test'})).status,409);
  assert.equal((await request('POST',`/api/projects/${p.id}/samples`,{sample_id:s.sample_id,matrix:'Groundwater'})).status,409);
  assert.equal((await request('PUT',`/api/projects/${p.id}/samples/${s.id}`,{status:'Collected'})).status,400);
  assert.equal((await request('PUT',`/api/projects/${p.id}/samples/${s.id}`,{collected_date:'2026-02-30'})).status,400);
  assert.equal((await request('PUT',`/api/projects/${p.id}/samples/${s.id}`,{coc_link:'javascript:alert(1)'})).status,400);
  assert.equal((await request('POST',`/api/projects/${p.id}/samples/${s.id}/tests`,{name:'Lead',status:'Reported'})).status,400);
  const r=await request('POST',`/api/projects/${p.id}/samples/${s.id}/tests`,{name:'Lead',method:'200.8',status:'Reported',result:'ND',units:'mg/L'});assert.equal(r.status,201);
  assert.equal((await request('POST',`/api/projects/${p.id}/samples/${s.id}/tests`,{name:'Lead',method:'200.8'})).status,409);
});

test('Invoice validation and transaction rollback avoid partial headers/items; concurrent writes are serialized',async t=>{
  const {db,request}=await fixture(t),p=await project(request);
  for(const body of [{...invoiceBody,items:[]},{...invoiceBody,due_date:'2026-09-01'},{...invoiceBody,items:[{description:'X',quantity:1,unit_price_cents:1.5}]},{...invoiceBody,items:[{description:'X',quantity:-1,unit_price_cents:100}]}])assert.equal((await request('POST',`/api/projects/${p.id}/invoices`,body)).status,400);
  assert.equal((await db.get('SELECT COUNT(*) n FROM invoices')).n,0);
  await db.exec("CREATE TRIGGER fail_item BEFORE INSERT ON invoice_items WHEN NEW.description='Force rollback' BEGIN SELECT RAISE(ABORT,'test rollback'); END");
  let r=await request('POST',`/api/projects/${p.id}/invoices`,{...invoiceBody,items:[invoiceBody.items[0],{description:'Force rollback',quantity:1,unit_price_cents:10}]});assert.equal(r.status,409);
  assert.equal((await db.get('SELECT COUNT(*) n FROM invoices')).n,0);assert.equal((await db.get('SELECT COUNT(*) n FROM invoice_items')).n,0);
  await db.exec('DROP TRIGGER fail_item');
  const results=await Promise.all(Array.from({length:5},(_,i)=>request('POST',`/api/projects/${p.id}/invoices`,{...invoiceBody,number:`INV-${i}`})));
  assert.ok(results.every(r=>r.status===201));assert.equal((await db.get('SELECT COUNT(*) n FROM invoices')).n,5);assert.equal((await db.get('SELECT COUNT(*) n FROM invoice_items')).n,10);
});

test('Legacy scheduled stops survive idempotent migration, restart and verified backup/restore',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'ecogo-persistence-'));t.after(()=>rm(directory,{recursive:true,force:true}));const filename=path.join(directory,'schedule.db');
  let db=await open({filename,driver:sqlite3.Database});
  await db.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT,stop_number INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'Pending',work_type TEXT NOT NULL,company TEXT NOT NULL,address TEXT NOT NULL,contact_name TEXT DEFAULT '',contact_phone TEXT DEFAULT '',instructions TEXT DEFAULT '',lab TEXT DEFAULT '',coc_link TEXT DEFAULT '',driver TEXT DEFAULT '',scheduled_date TEXT NOT NULL,scheduled_time TEXT DEFAULT '',arrival_time TEXT DEFAULT '',leaving_time TEXT DEFAULT '',miles REAL DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await db.run("INSERT INTO tasks (work_type,company,address,scheduled_date,scheduled_time) VALUES ('Tap Water Grab','Legacy test','Test address','2026-10-07','14:30')");await db.close();
  db=await openDatabase(filename);assert.equal((await db.get('SELECT * FROM tasks')).scheduled_time,'14:30');assert.equal((await db.get('SELECT * FROM tasks')).project_id,null);
  assert.equal((await readdir(path.join(directory,'backups'))).length,1);
  await db.run("INSERT INTO projects(code,name,client) VALUES ('PERSIST','Persistence test','Sample Client')");
  await db.run("INSERT INTO samples(project_id,sample_id,matrix) VALUES (1,'S-1','Soil')");
  await db.run("INSERT INTO sample_tests(sample_id,name,result,status) VALUES (1,'Test','ND','Reported')");
  await db.run("INSERT INTO invoices(project_id,number,issued_date,due_date) VALUES (1,'PERSIST-INV','2026-10-07','2026-11-07')");
  await db.run("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_cents,amount_cents) VALUES (1,'Work',2,100,200)");await db.close();
  db=await openDatabase(filename);assert.equal((await db.get('SELECT * FROM sample_tests')).result,'ND');await db.close();
  assert.equal((await readdir(path.join(directory,'backups'))).length,1,'migration runs once');
  const backup=path.join(directory,'snapshot.db'),restored=path.join(directory,'restored.db');await backupDatabase(filename,backup);await restoreDatabase(backup,restored);await verifyDatabase(restored);
  db=await openDatabase(restored);assert.equal((await db.get('SELECT * FROM tasks')).scheduled_time,'14:30');assert.equal((await db.get('SELECT * FROM invoice_items')).amount_cents,200);await db.close();
  await assert.rejects(restoreDatabase(backup,restored),/already exists/);await assert.rejects(backupDatabase(filename,backup),/already exists/);
  const bad=path.join(directory,'corrupt.db');await writeFile(bad,'not a database');await assert.rejects(restoreDatabase(bad,path.join(directory,'bad-restore.db')));
});

test('Production storage guards and Florida date boundaries',async t=>{
  await assert.rejects(databaseFilename({NODE_ENV:'production'}),/Persistent storage/);
  const directory=await mkdtemp(path.join(tmpdir(),'ecogo-storage-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const env={NODE_ENV:'production',DB_FILE:path.join(directory,'schedule.db'),PERSISTENT_DATA_DIR:directory,STORAGE_READY:'1'};
  await assert.rejects(databaseFilename(env),/Database is missing/);
  assert.equal(await databaseFilename({...env,ALLOW_NEW_DATABASE:'1'}),env.DB_FILE);
  await assert.rejects(databaseFilename({...env,DB_FILE:path.join(tmpdir(),'outside.db'),ALLOW_NEW_DATABASE:'1'}),/inside/);
  const {symlink}=await import('node:fs/promises');
  const outside=path.join(directory,'..',`outside-${path.basename(directory)}.db`);await writeFile(outside,'synthetic');t.after(()=>rm(outside,{force:true}));await symlink(outside,env.DB_FILE);
  await assert.rejects(databaseFilename(env),/inside/);
  assert.equal(floridaDate(new Date('2026-10-07T03:59:59Z')),'2026-10-06');assert.equal(floridaDate(new Date('2026-10-07T04:00:00Z')),'2026-10-07');
});
