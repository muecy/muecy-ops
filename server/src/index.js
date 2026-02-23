// server/src/index.js
import "dotenv/config"
import express from "express"
import cron from "node-cron"

import { prisma } from "./db.js"
import { getOAuthClient, SCOPES } from "./google.js"
import { syncGmailToTasks } from "./jobs.js"
import { startBot } from "./bot.js"

/* =========================
APP
========================= */
const app = express();
app.use(express.json({ limit: "1mb" }));
// --------------------
// GOOGLE OAUTH ROUTES
// --------------------
app.get("/auth/google", (req, res) => {
const oauth2Client = getOAuthClient();

const url = oauth2Client.generateAuthUrl({
access_type: "offline",
prompt: "consent",
scope: SCOPES,
});

return res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
try {
const code = req.query.code;
if (!code) return res.status(400).send("Missing ?code");

const oauth2Client = getOAuthClient();
const { tokens } = await oauth2Client.getToken(code);
oauth2Client.setCredentials(tokens);

// Guardar tokens en el OWNER (MVP single owner)
const ownerEmail = process.env.OWNER_EMAIL || "owner@muecy.local"
await prisma.user.update({
where: { email: ownerEmail },
data: {
accessToken: tokens.access_token || null,
refreshToken: tokens.refresh_token || null,
tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
},
});

return res.send("✅ Google conectado. Ya puedes cerrar esta ventana.");
} catch (err) {
console.error(err);
return res.status(500).send("OAuth callback error. Revisa consola.");
}
});
// ===============================
// TEST API ENDPOINTS
// ===============================

app.get("/api/users", async (req, res) => {
try {
const users = await prisma.user.findMany({
include: { tasks: true }
});
res.json(users);
} catch (err) {
console.error(err);
res.status(500).json({ error: "Failed to fetch users" });
}
});

app.get("/api/tasks", async (req, res) => {
try {
const tasks = await prisma.task.findMany();
res.json(tasks);
} catch (err) {
console.error(err);
res.status(500).json({ error: "Failed to fetch tasks" });
}
});
/* =========================
SINGLE OWNER (MVP)
========================= */
async function ensureOwner() {
const email = process.env.OWNER_EMAIL || "owner@muecy.local"
let user = await prisma.user.findUnique({ where: { email } });
if (!user) user = await prisma.user.create({ data: { email } });
return user;
}

/* =========================
BOOT
========================= */
let owner = null;
let bot = null;

async function boot() {
owner = await ensureOwner();

// Start Telegram bot (single owner)
if (process.env.TELEGRAM_BOT_TOKEN) {
bot = startBot({ userId: owner.id });
}


console.log("✅ Boot OK");
console.log(`👤 Owner: ${owner.email} (${owner.id})`);
}

/* =========================
ROUTES
========================= */

// Health / Root
app.get("/", (req, res) => {
res.status(200).send("Muëcy Ops is running ✅");
});

app.get("/health", (req, res) => {
res.status(200).json({ ok: true, service: "muecy-ops" });
});

// OAuth start
app.get("/auth/google", (req, res) => {
const oauth2 = getOAuthClient();
const url = oauth2.generateAuthUrl({
access_type: "offline",
scope: SCOPES,
prompt: "consent",
});
res.redirect(url);
});

// OAuth callback
app.get("/auth/google/callback", async (req, res) => {
try {
const code = req.query.code;
if (!code) return res.status(400).send("Missing code");

const oauth2 = getOAuthClient();
const { tokens } = await oauth2.getToken(code);

if (!owner?.id) owner = await ensureOwner();

await prisma.user.update({
where: { id: owner.id },
data: {
accessToken: tokens.access_token || null,
refreshToken: tokens.refresh_token || null,
tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
},
});

res.send("✅ Google conectado. Ya puedes sincronizar.");
} catch (e) {
console.error("OAuth callback error:", e);
res.status(500).send("❌ Error conectando Google.");
}
});

// Manual sync endpoint
app.post("/sync", async (req, res) => {
try {
if (!owner?.id) owner = await ensureOwner();
const r = await syncGmailToTasks(owner.id);
res.json({ ok: true, ...r });
} catch (e) {
console.error("Manual sync error:", e);
res.status(500).json({ ok: false, error: "sync_failed" });
}
});

/* =========================
DAILY BRIEFING (07:40 NY)
========================= */
cron.schedule(
"40 7 * * *",
async () => {
try {
if (!owner?.id) owner = await ensureOwner();

// 1) Sync Gmail -> Tasks
await syncGmailToTasks(owner.id);

// 2) Fetch top tasks
const tasks = await prisma.task.findMany({
where: {
userId: owner.id,
status: { in: ["PENDING", "DOING", "BLOCKED"] },
},
orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
take: 10,
});

const lines = [
"🧠 MUËCY OPS — Briefing",
`📅 ${new Date().toLocaleDateString("en-US", {
weekday: "long",
year: "numeric",
month: "short",
day: "numeric",
})}`,
"",
"🔴 Top tareas:",
...tasks.map((t) => `- [P${t.priority}] ${t.title}`),
"",
"Escribe: top | hoy | tarea: ... | done: ...",
];

// 3) Send Telegram
if (process.env.TELEGRAM_CHAT_ID && bot?.sendMessage) {
await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, lines.join("\n"));
} else {
console.log("ℹ️ Briefing listo (no TELEGRAM_CHAT_ID configurado).");
}
} catch (e) {
console.error("Briefing error:", e);
}
},
{ timezone: "America/New_York" }
);

/* =========================
ERROR HANDLERS
========================= */
process.on("unhandledRejection", (err) => {
console.error("UnhandledRejection:", err);
});

process.on("uncaughtException", (err) => {
console.error("UncaughtException:", err);
});

/* =========================
START SERVER
========================= */
const port = Number(process.env.PORT || 8080);
app.get("/api/calendar/list", async (req, res) => {
try {
// Este helper debería existir en tu proyecto (ya lo importas como getOAuthClient)
const auth = getOAuthClient();

// En este MVP, guardamos tokens en el "owner"
const ownerEmail = process.env.OWNER_EMAIL || "owner@muecy.local"
const owner = await prisma.user.findUnique({ where: { email: ownerEmail } });

if (!owner?.accessToken) {
return res.status(401).json({
error: "Not connected to Google yet (missing accessToken). Go to /auth/google",
});
}

// Set credentials from DB
auth.setCredentials({
access_token: owner.accessToken,
refresh_token: owner.refreshToken || undefined,
expiry_date: owner.tokenExpiry ? new Date(owner.tokenExpiry).getTime() : undefined,
});

const { google } = await import("googleapis");
const calendar = google.calendar({ version: "v3", auth });

const now = new Date().toISOString();
const out = await calendar.events.list({
calendarId: "primary",
timeMin: now,
maxResults: 10,
singleEvents: true,
orderBy: "startTime",
});

const events = (out.data.items || []).map(e => ({
id: e.id,
summary: e.summary,
start: e.start?.dateTime || e.start?.date,
end: e.end?.dateTime || e.end?.date,
location: e.location,
}));

res.json({ ok: true, count: events.length, events });
} catch (err) {
console.error(err);
res.status(500).json({ error: "Calendar fetch failed" });
}
});
app.post("/telegram/webhook", async (req, res) => {
  console.log("Telegram update:", req.body);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const message = req.body?.message?.text;
  const chatId = req.body?.message?.chat?.id;

  if (!chatId) return res.sendStatus(200);

  const send = async (text) => {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text })
    });
  };

  if (message === "/start") {
    await send("Muëcy Ops conectado en Railway ✅");
  }

  if (message === "/calendar") {
    const base = process.env.APP_BASE_URL;
    const r = await fetch(`${base}/api/calendar/list`);
    const data = await r.json();

    const lines = (data.events || []).map(e =>
      `• ${e.summary}\n  ${e.start}`
    );

    await send(lines.join("\n\n") || "No hay eventos.");
  }

  res.sendStatus(200);
});
boot()
.then(() => {
app.listen(port, "0.0.0.0", () => {
console.log(`Muëcy Ops running on port ${port}`);
const base = process.env.APP_BASE_URL || "(set APP_BASE_URL)"
console.log(`Connect Google: ${base}/auth/google`);
});
})
.catch((e) => {
console.error("❌ Boot failed:", e);
process.exit(1);
});
