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
bot = startBot({ userId: owner.id });

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
