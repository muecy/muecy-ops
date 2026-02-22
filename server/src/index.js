import "dotenv/config"
import express from "express"
import cron from "node-cron"
import { prisma } from "./db.js"
import { getOAuthClient, SCOPES } from "./google.js"
import { syncGmailToTasks } from "./jobs.js"
import { startBot } from "./bot.js"

const app = express();
app.use(express.json());

const TZ = "America/New_York"

function formatNYDate() {
return new Date().toLocaleDateString("en-US", {
timeZone: TZ,
weekday: "long",
year: "numeric",
month: "short",
day: "numeric",
});
}

// Single-owner MVP
async function ensureOwner() {
const email = process.env.OWNER_EMAIL || "owner@muecy.local"
let user = await prisma.user.findUnique({ where: { email } });
if (!user) user = await prisma.user.create({ data: { email } });
return user;
}

async function main() {
// Ensure DB connection early (optional but helpful)
await prisma.$connect();

const owner = await ensureOwner();

// Start Telegram bot only if token exists
let bot = null;
if (process.env.TELEGRAM_BOT_TOKEN) {
bot = startBot({ userId: owner.id });
console.log("✅ Telegram bot started");
} else {
console.warn("⚠️ TELEGRAM_BOT_TOKEN missing — bot not started");
}

// Routes
app.get("/", (req, res) => res.status(200).send("Muëcy Ops is running ✅"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

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

// IMPORTANT:
// Google may NOT return refresh_token every time.
// Preserve existing refresh token if not provided.
const current = await prisma.user.findUnique({ where: { id: owner.id } });

await prisma.user.update({
where: { id: owner.id },
data: {
accessToken: tokens.access_token ?? current?.accessToken ?? null,
refreshToken: tokens.refresh_token ?? current?.refreshToken ?? null,
tokenExpiry: tokens.expiry_date
? new Date(tokens.expiry_date)
: current?.tokenExpiry ?? null,
},
});

res.send("✅ Google conectado. Ya puedes sincronizar.");
} catch (e) {
console.error("OAuth callback error", e);
res.status(500).send("❌ Error conectando Google");
}
});

// Manual sync endpoint
app.post("/sync", async (req, res) => {
try {
const r = await syncGmailToTasks(owner.id);
res.json({ ok: true, ...r });
} catch (e) {
console.error("Sync error", e);
res.status(500).json({ ok: false, error: String(e?.message || e) });
}
});

// Daily briefing 07:40 New York
cron.schedule(
"40 7 * * *",
async () => {
try {
await syncGmailToTasks(owner.id);

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
`📅 ${formatNYDate()}`,
"",
"🔴 Top tareas:",
...tasks.map((t) => `- [P${t.priority}] ${t.title}`),
"",
"Escribe: top | hoy | tarea: ... | done: ...",
];

const chatId = process.env.TELEGRAM_CHAT_ID;

if (chatId && bot) {
await bot.sendMessage(chatId, lines.join("\n"));
} else {
console.warn(
"⚠️ Briefing not sent: missing TELEGRAM_CHAT_ID or bot not running"
);
}
} catch (e) {
console.error("Briefing error", e);
}
},
{ timezone: TZ }
);

// Start server
const port = Number(process.env.PORT || 8080);
app.listen(port, "0.0.0.0", () => {
const baseUrl = process.env.APP_BASE_URL || "(set APP_BASE_URL)"
console.log(`Muëcy Ops running on port ${port}`);
console.log(`Connect Google: ${baseUrl}/auth/google`);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
try {
await prisma.$disconnect();
} finally {
process.exit(0);
}
});
process.on("SIGINT", async () => {
try {
await prisma.$disconnect();
} finally {
process.exit(0);
}
});
}

main().catch((e) => {
console.error("Fatal startup error", e);
process.exit(1);
});
