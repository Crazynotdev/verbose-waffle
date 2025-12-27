import express from "express";
import http from "http";
import { Server as IOServer } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import { createPairing } from "./pair/pair.js";
import { handleOutgoingCommand } from "./bot/commands.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "please_change_me";
const DB_FILE = process.env.DB_FILE || "./data/db.json";
const SESSIONS_DIR = process.env.SESSIONS_DIR || "./sessions";
const MAX_ACTIVE_SESSIONS = parseInt(process.env.MAX_ACTIVE_SESSIONS || "40", 10);
const COINS_PER_MINUTE = parseInt(process.env.COINS_PER_MINUTE || "1", 10);
const PAIRING_COST = parseInt(process.env.PAIRING_COST || "5", 10);

fs.mkdirSync(path.resolve(SESSIONS_DIR), { recursive: true });
fs.mkdirSync(path.resolve("./data"), { recursive: true });

// LowDB setup
const adapter = new JSONFile(DB_FILE);
const db = new Low(adapter);

await db.read();
db.data = db.data || {
  users: [], // {id, email, passwordHash, coins, createdAt, lastPairAt}
  sessionsMeta: [], // tracked app sessions {id, ownerUserId, phoneNumber, createdAt, status, folder}
  activeCount: 0
};
await db.write();

// In-memory map of session sockets for runtime management
const runtimeSessions = new Map(); // sessionId -> { socket, meta, pairingWatcher }

const app = express();
const server = http.createServer(app);
const io = new IOServer(server, {
  cors: { origin: "*" }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Utility
function createToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: process.env.TOKEN_EXPIRY || "7d" });
}

async function findUserByEmail(email) {
  await db.read();
  return db.data.users.find(u => u.email === email);
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: "Missing authorization token" });
  const token = auth.split(" ")[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// Public endpoints
app.post("/api/register", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  const existing = await findUserByEmail(email);
  if (existing) return res.status(400).json({ error: "Email already registered" });
  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash(password, salt);
  const user = { id: uuidv4(), email, passwordHash: hash, coins: 100, createdAt: new Date().toISOString(), lastPairAt: 0 };
  db.data.users.push(user);
  await db.write();
  const token = createToken(user);
  res.json({ token, user: { id: user.id, email: user.email, coins: user.coins } });
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await findUserByEmail(email);
  if (!user) return res.status(400).json({ error: "Invalid credentials" });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(400).json({ error: "Invalid credentials" });
  const token = createToken(user);
  res.json({ token, user: { id: user.id, email: user.email, coins: user.coins } });
});

// Create pairing request
app.post("/api/create-pair", authMiddleware, async (req, res) => {
  await db.read();
  const user = db.data.users.find(u => u.id === req.user.id);
  if (!user) return res.status(401).json({ error: "User not found" });
  const { phoneNumber } = req.body;
  if (!phoneNumber || !/^\d{6,15}$/.test(phoneNumber)) return res.status(400).json({ error: "Invalid phone number format. Use international digits only." });

  // Rate / spam protection: allow one pairing per 30s per user
  const now = Date.now();
  if (user.lastPairAt && now - user.lastPairAt < 30_000) {
    return res.status(429).json({ error: "Pairing requests are limited. Wait before requesting again." });
  }

  // SaaS limit
  const active = db.data.sessionsMeta.filter(s => s.status === "connected" || s.status === "pairing").length;
  if (active >= MAX_ACTIVE_SESSIONS) {
    return res.status(409).json({ error: "Active sessions limit reached. Try later." });
  }

  // Coins check (cost to start)
  if (user.coins < PAIRING_COST) return res.status(402).json({ error: "Not enough coins to start a session." });

  // Deduct initial cost and save pending session
  user.coins -= PAIRING_COST;
  user.lastPairAt = now;
  const sessionId = uuidv4();
  const folder = path.join(SESSIONS_DIR, `session-${sessionId}`);
  fs.mkdirSync(folder, { recursive: true });

  const meta = {
    id: sessionId,
    ownerUserId: user.id,
    phoneNumber,
    createdAt: new Date().toISOString(),
    status: "pairing",
    folder
  };
  db.data.sessionsMeta.push(meta);
  await db.write();

  // Start pairing (non-blocking) — pairing will emit updates via Socket.IO
  const socketNamespace = io.of(`/pair/${sessionId}`);
  // createPairing will emit pairing updates using provided io namespace
  try {
    createPairing({ sessionId, folder, phoneNumber, ownerUserId: user.id, namespace: socketNamespace, db, runtimeSessions, handleOutgoingCommand });
  } catch (err) {
    console.error("Pair creation error:", err);
  }

  res.json({ sessionId, status: "pairing" });
});

// List sessions for user
app.get("/api/sessions", authMiddleware, async (req, res) => {
  await db.read();
  const userSessions = db.data.sessionsMeta.filter(s => s.ownerUserId === req.user.id);
  res.json({ sessions: userSessions });
});

// Send command to a session (user must own session)
app.post("/api/sessions/:sessionId/command", authMiddleware, async (req, res) => {
  const { sessionId } = req.params;
  const { commandText } = req.body;
  if (!commandText) return res.status(400).json({ error: "commandText required" });

  await db.read();
  const meta = db.data.sessionsMeta.find(s => s.id === sessionId);
  if (!meta) return res.status(404).json({ error: "Session not found" });
  if (meta.ownerUserId !== req.user.id) return res.status(403).json({ error: "Not the owner" });
  if (meta.status !== "connected") return res.status(409).json({ error: "Session not connected" });

  const runtime = runtimeSessions.get(sessionId);
  if (!runtime || !runtime.sock) return res.status(500).json({ error: "Session socket not available" });

  try {
    const result = await handleOutgoingCommand(runtime.sock, meta, commandText);
    res.json({ ok: true, result });
  } catch (err) {
    console.error("Command error:", err);
    res.status(500).json({ error: "Command failed", details: String(err) });
  }
});

// Simple admin-like endpoint to get counts
app.get("/api/status", async (req, res) => {
  await db.read();
  res.json({ activeSessions: db.data.sessionsMeta.filter(s => s.status === "connected" || s.status === "pairing").length });
});

// Serve front
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Socket.IO: global events are not used; pairing uses namespace per session
io.on("connection", socket => {
  console.log("socket connected global:", socket.id);
});

// Background job: charge coins per minute for connected sessions
setInterval(async () => {
  await db.read();
  const now = Date.now();
  for (const s of db.data.sessionsMeta.filter(x => x.status === "connected")) {
    const user = db.data.users.find(u => u.id === s.ownerUserId);
    if (!user) continue;
    // Deduct coins per minute
    if (!s.lastChargedAt) s.lastChargedAt = now;
    const ms = now - s.lastChargedAt;
    if (ms >= 60_000) {
      const minutes = Math.floor(ms / 60_000);
      const cost = minutes * COINS_PER_MINUTE;
      user.coins = Math.max(0, user.coins - cost);
      s.lastChargedAt = now;
      // If user out of coins, disconnect session
      if (user.coins <= 0) {
        // mark session to disconnect
        s.status = "suspended";
        const runtime = runtimeSessions.get(s.id);
        if (runtime && runtime.sock) {
          try {
            await runtime.sock.logout();
          } catch (e) {}
        }
      }
    }
  }
  await db.write();
}, 60_000);

// Start server
server.listen(PORT, () => {
  console.log(`CRAZY MINI running on port ${PORT}`);
});
