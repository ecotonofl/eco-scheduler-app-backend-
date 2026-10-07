import express from 'express';
import cors from 'cors';
import { ApiError, text, id, choice, date, time, number, link } from './validation.js';

const projectStatuses = ['Active','On Hold','Completed'];
const sampleStatuses = ['Planned','Collected','At Lab','Reported'];
const matrices = ['Groundwater','Drinking Water','Wastewater','Soil','Surface Water','Reclaimed Water'];
const taskStatuses = ['Pending','In Progress','Completed','Canceled','Rescheduled'];
const workTypes = ['Line Clearance','Ground Water Sampling','Soil Grab','Soil Composite','Tap Water Grab','Waste Water Composite','Waste Water Grab','Drinking Water Grab','Deep Wells Grab','Surface Water Grab'];
const invoiceSelect = `SELECT i.*, COALESCE((SELECT SUM(amount_cents) FROM invoice_items WHERE invoice_id=i.id),0) AS total_cents FROM invoices i`;

export function createApp(db, emit = () => {}) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '128kb' }));
  let queue = Promise.resolve();
  // One connection: serialize every write so invoice transactions cannot interleave.
  const write = action => { const work = queue.then(action); queue = work.catch(() => {}); return work; };
  const route = handler => async (req,res,next) => { try { await queue; await handler(req,res); } catch (error) { next(error); } };
  const getProject = async value => {
    const project = await db.get('SELECT * FROM projects WHERE id=?', id(value, 'Project'));
    if (!project) throw new ApiError(404, 'Project not found');
    return project;
  };
  const getSample = async (projectId, sampleId) => {
    await getProject(projectId);
    const sample = await db.get('SELECT * FROM samples WHERE id=? AND project_id=?', id(sampleId,'Sample'), id(projectId,'Project'));
    if (!sample) throw new ApiError(404, 'Sample not found in this project');
    return sample;
  };
  const projectBody = b => ({
    code: text(b.code,'Project code',{required:true,max:80}), name: text(b.name,'Project name',{required:true,max:200}),
    client: text(b.client,'Client',{required:true,max:200}), address: text(b.address,'Address'),
    contact_name: text(b.contact_name,'Contact name'), contact_phone: text(b.contact_phone,'Contact phone'),
    lab: text(b.lab,'Lab'), status: choice(b.status || 'Active', projectStatuses,'Project status'), notes: text(b.notes,'Notes')
  });
  const sampleBody = b => {
    const s = { sample_id: text(b.sample_id,'Sample ID',{required:true,max:120}), matrix: choice(b.matrix,matrices,'Matrix'),
      status: choice(b.status || 'Planned',sampleStatuses,'Sample status'), collected_date: date(b.collected_date,'Collection date',true),
      collected_time: time(b.collected_time,'Collection time'), lab: text(b.lab,'Lab'), coc_link: link(b.coc_link,'COC link'), notes: text(b.notes,'Notes') };
    if (s.status !== 'Planned' && (!s.collected_date || !s.collected_time)) throw new ApiError(400,'Collection date and time are required after collection');
    return s;
  };
  const testBody = b => {
    const t = {name:text(b.name,'Test name',{required:true,max:150}),method:text(b.method,'Method',{max:150}),
      status:choice(b.status || 'Requested',['Requested','In Progress','Reported'],'Test status'),result:text(b.result,'Result',{max:200}),
      units:text(b.units,'Units',{max:80}),qualifier:text(b.qualifier,'Qualifier',{max:80})};
    if(t.status==='Reported' && !t.result) throw new ApiError(400,'A reported test needs a result');
    return t;
  };
  const taskBody = async (b, existing) => {
    const projectId = b.project_id == null || b.project_id === '' ? null : id(b.project_id,'Project');
    const p = projectId ? await getProject(projectId) : null;
    const defaults = !existing && p ? {company:p.client,address:p.address,contact_name:p.contact_name,contact_phone:p.contact_phone,lab:p.lab} : {};
    const t = {...defaults,...b};
    return {stop_number:number(t.stop_number ?? 1,'Stop number',{min:1,integer:true}),status:choice(t.status || 'Pending',taskStatuses,'Stop status'),
      work_type:choice(t.work_type,workTypes,'Work type'),company:text(t.company,'Company',{required:true}),address:text(t.address,'Address',{required:true}),
      contact_name:text(t.contact_name,'Contact'),contact_phone:text(t.contact_phone,'Phone'),instructions:text(t.instructions,'Instructions'),lab:text(t.lab,'Lab'),
      coc_link:link(t.coc_link,'COC link'),driver:text(t.driver,'Driver'),scheduled_date:date(t.scheduled_date,'Scheduled date'),
      scheduled_time:time(t.scheduled_time,'Scheduled time'),arrival_time:text(t.arrival_time,'Arrival',{max:30}),leaving_time:text(t.leaving_time,'Leaving',{max:30}),
      miles:number(t.miles ?? 0,'Miles'),project_id:projectId};
  };
  const insert = async (table, values) => {
    const keys=Object.keys(values);return db.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`,Object.values(values));
  };
  const update = async (table, rowId, values) => {
    await db.run(`UPDATE ${table} SET ${Object.keys(values).map(k=>`${k}=?`).join(',')} WHERE id=?`,[...Object.values(values),rowId]);
  };
  app.get('/',(req,res)=>res.json({name:'EcoGo API',status:'running',workspace_version:1}));
  app.get('/api/tasks',route(async(req,res)=>{
    const clauses=[], params=[];
    if(req.query.date){clauses.push('t.scheduled_date=?');params.push(date(req.query.date,'Date'));}
    if(req.query.driver){clauses.push('t.driver=?');params.push(text(req.query.driver,'Driver'));}
    if(req.query.project_id){clauses.push('t.project_id=?');params.push(id(req.query.project_id,'Project'));}
    res.json(await db.all(`SELECT t.*,p.code AS project_code,p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id=t.project_id ${clauses.length?'WHERE '+clauses.join(' AND '):''} ORDER BY t.scheduled_date,t.stop_number`,params));
  }));
  app.post('/api/tasks',route(async(req,res)=>write(async()=>{
    const values=await taskBody(req.body);const r=await insert('tasks',values);const t=await db.get('SELECT * FROM tasks WHERE id=?',r.lastID);emit('taskUpdated',t);res.status(201).json(t);
  })));
  app.put('/api/tasks/:id',route(async(req,res)=>write(async()=>{
    const taskId=id(req.params.id);const existing=await db.get('SELECT * FROM tasks WHERE id=?',taskId);
    if(!existing)throw new ApiError(404,'Task not found');
    await update('tasks',taskId,await taskBody({...existing,...req.body},existing));const t=await db.get('SELECT * FROM tasks WHERE id=?',taskId);emit('taskUpdated',t);res.json(t);
  })));
  app.delete('/api/tasks/:id',route(async(req,res)=>write(async()=>{const taskId=id(req.params.id);await db.run('DELETE FROM tasks WHERE id=?',taskId);emit('taskDeleted',taskId);res.status(204).end();})));
  app.get('/api/projects',route(async(req,res)=>res.json(await db.all(`SELECT p.*,
    (SELECT COUNT(*) FROM tasks WHERE project_id=p.id) AS stop_count,
    (SELECT COUNT(*) FROM samples WHERE project_id=p.id) AS sample_count,
    COALESCE((SELECT SUM(ii.amount_cents) FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id WHERE i.project_id=p.id AND i.status IN ('Draft','Sent')),0) AS outstanding_cents
    FROM projects p ORDER BY p.id DESC`))));
  app.post('/api/projects',route(async(req,res)=>write(async()=>{const r=await insert('projects',projectBody(req.body));const p=await getProject(r.lastID);emit('workspaceUpdated',{project_id:p.id});res.status(201).json(p);})));
  app.put('/api/projects/:id',route(async(req,res)=>write(async()=>{const p=await getProject(req.params.id);await update('projects',p.id,projectBody({...p,...req.body}));emit('workspaceUpdated',{project_id:p.id});res.json(await getProject(p.id));})));
  app.get('/api/projects/:id',route(async(req,res)=>{
    const p=await getProject(req.params.id);
    const samples=await db.all('SELECT * FROM samples WHERE project_id=? ORDER BY id',p.id);
    const tests=await db.all('SELECT t.* FROM sample_tests t JOIN samples s ON s.id=t.sample_id WHERE s.project_id=? ORDER BY t.id',p.id);
    for(const s of samples)s.tests=tests.filter(t=>t.sample_id===s.id);
    res.json({project:p,tasks:await db.all('SELECT * FROM tasks WHERE project_id=? ORDER BY scheduled_date,stop_number',p.id),samples,
      invoices:await db.all(invoiceSelect+' WHERE i.project_id=? ORDER BY i.id DESC',p.id)});
  }));
  app.post('/api/projects/:id/samples',route(async(req,res)=>write(async()=>{const p=await getProject(req.params.id);const r=await insert('samples',{project_id:p.id,...sampleBody({lab:p.lab,...req.body})});emit('workspaceUpdated',{project_id:p.id});res.status(201).json(await db.get('SELECT * FROM samples WHERE id=?',r.lastID));})));
  app.put('/api/projects/:id/samples/:sampleId',route(async(req,res)=>write(async()=>{const s=await getSample(req.params.id,req.params.sampleId);await update('samples',s.id,sampleBody({...s,...req.body}));emit('workspaceUpdated',{project_id:s.project_id});res.json(await db.get('SELECT * FROM samples WHERE id=?',s.id));})));
  app.post('/api/projects/:id/samples/:sampleId/tests',route(async(req,res)=>write(async()=>{const s=await getSample(req.params.id,req.params.sampleId);const r=await insert('sample_tests',{sample_id:s.id,...testBody(req.body)});emit('workspaceUpdated',{project_id:s.project_id});res.status(201).json(await db.get('SELECT * FROM sample_tests WHERE id=?',r.lastID));})));
  app.put('/api/projects/:id/samples/:sampleId/tests/:testId',route(async(req,res)=>write(async()=>{
    const s=await getSample(req.params.id,req.params.sampleId);const t=await db.get('SELECT * FROM sample_tests WHERE id=? AND sample_id=?',id(req.params.testId,'Test'),s.id);
    if(!t)throw new ApiError(404,'Test not found in this sample');await update('sample_tests',t.id,testBody({...t,...req.body}));emit('workspaceUpdated',{project_id:s.project_id});res.json(await db.get('SELECT * FROM sample_tests WHERE id=?',t.id));
  })));
  app.post('/api/projects/:id/invoices',route(async(req,res)=>write(async()=>{
    const p=await getProject(req.params.id),b=req.body;
    const invoice={project_id:p.id,number:text(b.number,'Invoice number',{required:true,max:80}),issued_date:date(b.issued_date,'Issue date'),due_date:date(b.due_date,'Due date'),notes:text(b.notes,'Notes')};
    if(invoice.due_date<invoice.issued_date)throw new ApiError(400,'Due date must not precede issue date');
    if(!Array.isArray(b.items)||!b.items.length||b.items.length>100)throw new ApiError(400,'Invoice needs 1–100 line items');
    const items=b.items.map(item=>{
      const quantity=number(item.quantity,'Quantity',{min:0.001,max:100000});
      if(Math.abs(quantity*1000-Math.round(quantity*1000))>0.00001)throw new ApiError(400,'Quantity supports up to three decimal places');
      const unit_price_cents=number(item.unit_price_cents,'Unit price',{integer:true,max:100000000});
      return {description:text(item.description,'Description',{required:true,max:500}),quantity,unit_price_cents,amount_cents:Math.round(quantity*unit_price_cents)};
    });
    await db.exec('BEGIN IMMEDIATE');
    let invoiceId;
    try { const r=await insert('invoices',invoice);invoiceId=r.lastID;for(const item of items)await insert('invoice_items',{invoice_id:invoiceId,...item});await db.exec('COMMIT'); }
    catch(error){await db.exec('ROLLBACK');throw error;}
    emit('workspaceUpdated',{project_id:p.id});res.status(201).json(await db.get(invoiceSelect+' WHERE i.id=?',invoiceId));
  })));
  app.get('/api/projects/:id/invoices/:invoiceId',route(async(req,res)=>{
    const p=await getProject(req.params.id);const invoice=await db.get(invoiceSelect+' WHERE i.id=? AND i.project_id=?',[id(req.params.invoiceId,'Invoice'),p.id]);
    if(!invoice)throw new ApiError(404,'Invoice not found in this project');res.json({...invoice,items:await db.all('SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY id',invoice.id),project:p});
  }));
  app.put('/api/projects/:id/invoices/:invoiceId/status',route(async(req,res)=>write(async()=>{
    const p=await getProject(req.params.id);const invoice=await db.get('SELECT * FROM invoices WHERE id=? AND project_id=?',[id(req.params.invoiceId,'Invoice'),p.id]);
    if(!invoice)throw new ApiError(404,'Invoice not found in this project');
    const transitions={Draft:['Sent','Void'],Sent:['Paid','Void'],Paid:[],Void:[]};
    if(!transitions[invoice.status].includes(req.body.status))throw new ApiError(409,'Invoice status transition is not allowed');
    await db.run('UPDATE invoices SET status=? WHERE id=?',[req.body.status,invoice.id]);emit('workspaceUpdated',{project_id:p.id});res.json(await db.get(invoiceSelect+' WHERE i.id=?',invoice.id));
  })));
  app.use((error,req,res,next)=>{
    if(error instanceof ApiError)return res.status(error.status).json({error:error.message});
    if(error.code==='SQLITE_CONSTRAINT')return res.status(409).json({error:'A duplicate or invalid relationship conflicts with existing records.'});
    if(error.type==='entity.parse.failed')return res.status(400).json({error:'Invalid JSON'});
    if(error.type==='entity.too.large')return res.status(413).json({error:'Request is too large'});
    console.error(error);res.status(500).json({error:'Unable to save or load data. Please try again.'});
  });
  return app;
}
