import http from 'node:http';
import { Server as IOServer } from 'socket.io';
import { databaseFilename, openDatabase } from './src/database.js';
import { createApp } from './src/app.js';

const filename = await databaseFilename();
const db = await openDatabase(filename, { seedDemo: process.env.SEED_DEMO === '1' && process.env.NODE_ENV !== 'production' && process.env.RENDER !== 'true' });
let io;
const app = createApp(db, (event, data) => io?.emit(event, data));
const server = http.createServer(app);
io = new IOServer(server, { cors: { origin: '*', methods: ['GET','POST','PUT','DELETE'] } });
const port = process.env.PORT || 4000;
server.listen(port, () => console.log(`EcoGo API running on ${port}`));
let stopping=false;
async function shutdown() {
  if(stopping)return;stopping=true;
  io.close();server.close(async()=>{await db.close();process.exit(0);});
  setTimeout(()=>process.exit(1),10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
