import express from "express";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import http from "http";
import { Server as IOServer } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const io = new IOServer(server, { cors: { origin: "*", methods: ["GET","POST","PUT","DELETE"] } });
const dbPromise = open({ filename: process.env.DB_FILE || "./schedule.db", driver: sqlite3.Database });

const init = async () => {
  const db = await dbPromise;
  await db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stop_number INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'Pending',
    work_type TEXT NOT NULL,
    company TEXT NOT NULL,
    address TEXT NOT NULL,
    contact_name TEXT DEFAULT '',
    contact_phone TEXT DEFAULT '',
    instructions TEXT DEFAULT '',
    lab TEXT DEFAULT '',
    coc_link TEXT DEFAULT '',
    driver TEXT DEFAULT '',
    scheduled_date TEXT NOT NULL,
    arrival_time TEXT DEFAULT '',
    leaving_time TEXT DEFAULT '',
    miles REAL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  const row = await db.get("SELECT COUNT(*) AS n FROM tasks");
  if (!row.n) {
    await db.run(`INSERT INTO tasks (stop_number,work_type,company,address,contact_name,contact_phone,instructions,lab,driver,scheduled_date)
      VALUES (1,'Ground Water Sampling','Demo Client','123 Sample Ave, Pompano Beach, FL','Site Contact','954-555-0100','Bring GWL, calibration log and COC.','Eurofins','Driver 1',date('now'))`);
  }
};
await init();

app.get("/", (req,res)=>res.json({name:"EcoGo API",status:"running"}));
app.get("/api/tasks", async (req,res)=>{
  const db=await dbPromise;
  const params=[]; let where=[];
  if(req.query.date){where.push("scheduled_date=?");params.push(req.query.date)}
  if(req.query.driver){where.push("driver=?");params.push(req.query.driver)}
  const sql="SELECT * FROM tasks"+(where.length?" WHERE "+where.join(" AND "):"")+" ORDER BY scheduled_date, stop_number";
  res.json(await db.all(sql,params));
});
app.post("/api/tasks", async (req,res)=>{
  const db=await dbPromise; const b=req.body;
  const result=await db.run(`INSERT INTO tasks (stop_number,status,work_type,company,address,contact_name,contact_phone,instructions,lab,coc_link,driver,scheduled_date,miles)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,[b.stop_number||1,b.status||"Pending",b.work_type,b.company,b.address,b.contact_name||"",b.contact_phone||"",b.instructions||"",b.lab||"",b.coc_link||"",b.driver||"",b.scheduled_date,b.miles||0]);
  const task=await db.get("SELECT * FROM tasks WHERE id=?",result.lastID); io.emit("taskUpdated",task); res.status(201).json(task);
});
app.put("/api/tasks/:id", async (req,res)=>{
  const db=await dbPromise; const existing=await db.get("SELECT * FROM tasks WHERE id=?",req.params.id);
  if(!existing) return res.status(404).json({error:"Task not found"});
  const t={...existing,...req.body};
  await db.run(`UPDATE tasks SET stop_number=?,status=?,work_type=?,company=?,address=?,contact_name=?,contact_phone=?,instructions=?,lab=?,coc_link=?,driver=?,scheduled_date=?,arrival_time=?,leaving_time=?,miles=? WHERE id=?`,
  [t.stop_number,t.status,t.work_type,t.company,t.address,t.contact_name,t.contact_phone,t.instructions,t.lab,t.coc_link,t.driver,t.scheduled_date,t.arrival_time,t.leaving_time,t.miles,t.id]);
  const task=await db.get("SELECT * FROM tasks WHERE id=?",t.id); io.emit("taskUpdated",task); res.json(task);
});
app.delete("/api/tasks/:id", async(req,res)=>{const db=await dbPromise;await db.run("DELETE FROM tasks WHERE id=?",req.params.id);io.emit("taskDeleted",Number(req.params.id));res.status(204).end()});
io.on("connection",s=>console.log("EcoGo client connected",s.id));
const PORT=process.env.PORT||4000;
server.listen(PORT,()=>console.log(`EcoGo API running on ${PORT}`));
