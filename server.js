import express from "express";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import http from "http";
import { Server as IOServer } from "socket.io";
import bodyParser from "body-parser";
import cors from "cors";

const app = express();
app.use(cors());
app.use(bodyParser.json());

const server = http.createServer(app);
const io = new IOServer(server, {
  cors: { origin: "*", methods: ["GET", "POST", "PUT"] },
});

const dbPromise = open({ filename: "./schedule.db", driver: sqlite3.Database });

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);
  socket.on("joinTaskRoom", (taskId) => socket.join(`task_${taskId}`));
  socket.on("leaveTaskRoom", (taskId) => socket.leave(`task_${taskId}`));
  socket.on("disconnect", () => console.log("Socket disconnected:", socket.id));
});

app.get("/", (req, res) => res.send("Backend is running"));

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
