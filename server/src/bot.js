import TelegramBot from "node-telegram-bot-api"
import { prisma } from "./db.js"
import { parseCommand, normalizePriority } from "./parse.js"
import { google } from "googleapis"

/* =========================
HELPERS
========================= */

function splitParts(payload) {
return payload.split("/").map((s) => s.trim()).filter(Boolean);
}

function pickField(str, key) {
// key: loc | desc | invite | task
// acepta: "loc: Miami" hasta antes del próximo "/"
const re = new RegExp(`\\b${key}\\s*:\\s*([^/]+)`, "i");
const m = str.match(re);
return m ? m[1].trim() : ""
}

function removeFields(str) {
return str
.replace(/\bloc\s*:\s*[^/]+/gi, "")
.replace(/\bdesc\s*:\s*[^/]+/gi, "")
.replace(/\binvite\s*:\s*[^/]+/gi, "")
.replace(/\btask\s*:\s*[^/]+/gi, "")
.replace(/\s+/g, " ")
.trim();
}
 
function parseInviteList(v) {
if (!v) return [];
return v
.split(",")
.map((s) => s.trim())
.filter(Boolean)
.map((email) => ({ email }));
}

function getCalendarClient() {
const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
if (!raw) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON");

let creds;
try {
creds = JSON.parse(raw);
} catch {
creds = JSON.parse(raw.replace(/\\n/g, "\n"));
}

const auth = new google.auth.JWT({
email: creds.client_email,
key: creds.private_key,
scopes: ["https://www.googleapis.com/auth/calendar"],
});

return google.calendar({ version: "v3", auth });
}

function pad2(n) {
return String(n).padStart(2, "0");
}

// Devuelve { tz, local } donde local = "YYYY-MM-DDTHH:mm:00" en NY
function parseWhenToNYLocal(whenText) {
const tz = "America/New_York"

const nowNY = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
const base = new Date(nowNY.getTime());

const w = (whenText || "").toLowerCase().trim();

// fecha explícita YYYY-MM-DD (opcional)
const explicitDate = w.match(/(\d{4})-(\d{2})-(\d{2})/);
if (!explicitDate) {
if (w.includes("mañana") || w.includes("manana") || w.includes("tomorrow")) {
base.setDate(base.getDate() + 1);
}
}

// hora (3pm, 3:30pm, 15:00)
const m = w.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
if (!m) {
throw new Error('No pude leer la hora. Usa: "mañana 3pm" o "2026-02-23 15:00"');
}

let hh = parseInt(m[1], 10);
const mm = parseInt(m[2] || "0", 10);
const ampm = (m[3] || "").toLowerCase();

if (ampm === "pm" && hh < 12) hh += 12;
if (ampm === "am" && hh === 12) hh = 0;

if (explicitDate) {
const [, Y, M, D] = explicitDate;
return { tz, local: `${Y}-${M}-${D}T${pad2(hh)}:${pad2(mm)}:00` };
}

const Y = base.getFullYear();
const M = pad2(base.getMonth() + 1);
const D = pad2(base.getDate());
return { tz, local: `${Y}-${M}-${D}T${pad2(hh)}:${pad2(mm)}:00` };
}

function addMinutesToLocal(local, minutes) {
const [datePart, timePart] = local.split("T");
const [Y, M, D] = datePart.split("-").map(Number);
const [hh, mm] = timePart.split(":").map(Number);

const dt = new Date(Y, M - 1, D, hh, mm, 0);
dt.setMinutes(dt.getMinutes() + minutes);

return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}T${pad2(
dt.getHours()
)}:${pad2(dt.getMinutes())}:00`;
}

function nyLocalToDate(localStr) {
const [d, t] = localStr.split("T");
const [Y, M, D] = d.split("-").map(Number);
const [hh, mm] = t.split(":").map(Number);
return new Date(Y, M - 1, D, hh, mm, 0);
}

/* =========================
BOT
========================= */

export function startBot({ userId }) {
if (!process.env.TELEGRAM_BOT_TOKEN) {
throw new Error("Missing TELEGRAM_BOT_TOKEN");
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

bot.on("message", async (msg) => {
const chatId = String(msg.chat.id);
const text = (msg.text || "").trim();

// ✅ Auto-registrar chatId del owner (single owner)
try {
await prisma.user.update({
where: { id: userId },
data: {
telegramUserId: msg.from?.id ? String(msg.from.id) : null,
telegramChatId: chatId,
},
});
} catch (e) {
console.error("Telegram register error:", e);
}

/* ======================
EVENT (Google Calendar)
====================== */
if (/^\/?event\b/i.test(text.trim())) {
try {
const calendarId = process.env.GOOGLE_CALENDAR_ID;
if (!calendarId) throw new Error("Missing GOOGLE_CALENDAR_ID");

const raw = text.replace(/^\s*\/?event\b\s*:?\s*/i, "").trim();

// Extraer campos opcionales primero
const location = pickField(raw, "loc");
const description = pickField(raw, "desc");
const inviteRaw = pickField(raw, "invite");
const taskRaw = pickField(raw, "task");

// Ahora removemos SOLO loc/desc/invite (NO task)
const cleaned = raw
.replace(/\bloc\s*:\s*[^/]+/gi, "")
.replace(/\bdesc\s*:\s*[^/]+/gi, "")
.replace(/\binvite\s*:\s*[^/]+/gi, "")
.trim();

const parts = cleaned.split("/").map(s => s.trim()).filter(Boolean);

const title = parts[0] || "Evento Muëcy Ops"
const whenText = parts[1] || ""
const minutes = parseInt(parts[2] || "60", 10);

const { tz, local } = parseWhenToNYLocal(whenText);
const endLocal = addMinutesToLocal(local, Number.isFinite(minutes) ? minutes : 60);

const attendees = parseInviteList(inviteRaw);
const calendar = getCalendarClient();

const result = await calendar.events.insert({
calendarId,
requestBody: {
summary: title,
start: { dateTime: local, timeZone: tz },
end: { dateTime: endLocal, timeZone: tz },
...(location ? { location } : {}),
...(description ? { description } : {}),
...(attendees.length ? { attendees } : {}),
},
sendUpdates: attendees.length ? "all" : "none",
});

let linkedTask = null;

if (taskRaw) {
linkedTask = await prisma.task.create({
data: {
userId,
title: taskRaw,
priority: 2,
status: "PENDING",
source: "calendar",
},
});
}

const lines = [
`✅ Evento creado:`,
`${title}`,
`🕒 ${local} (${tz})`,
location ? `📍 ${location}` : null,
description ? `📝 ${description}` : null,
result?.data?.htmlLink || null,
linkedTask ? `🔗 Tarea vinculada: ${linkedTask.title}` : null,
].filter(Boolean);

await bot.sendMessage(chatId, lines.join("\n"));

} catch (e) {
await bot.sendMessage(chatId, `❌ No pude crear el evento. Detalle: ${e.message}`);
}

return;
}


/* ======================
TASK COMMANDS (Prisma)
====================== */
const cmd = parseCommand(text);

if (cmd.type === "task") {
const parts = splitParts(cmd.payload);
const title = parts[0] || "(tarea sin título)"
const assignee = parts[1] || null;
const priority = normalizePriority(parts[2] || "");

const task = await prisma.task.create({
data: { userId, title, assignee, priority, source: "manual", status: "PENDING" },
});

await bot.sendMessage(
chatId,
`✅ Tarea creada\n• ${task.title}\n• ${assignee ? `Rol: ${assignee}` : "Rol: (sin asignar)"}\n• Prioridad: P${task.priority}`
);
return;
}

if (cmd.type === "top") {
const tasks = await prisma.task.findMany({
where: { userId, status: { in: ["PENDING", "DOING", "BLOCKED"] } },
orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
take: 10,
});
const lines = ["🔴 Top 10 tareas:", ...tasks.map((t) => `- [P${t.priority}] ${t.title}`)];
await bot.sendMessage(chatId, lines.join("\n"));
return;
}

if (cmd.type === "today") {
const tasks = await prisma.task.findMany({
where: { userId, status: { in: ["PENDING", "DOING", "BLOCKED"] } },
orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
take: 20,
});
const lines = [
"📌 Pendientes:",
...tasks.map((t) => `- [${t.status}] [P${t.priority}] ${t.title}`),
];
await bot.sendMessage(chatId, lines.join("\n"));
return;
}

if (cmd.type === "done") {
const q = cmd.payload.toLowerCase();

const task = await prisma.task.findFirst({
where: {
userId,
status: { in: ["PENDING", "DOING", "BLOCKED"] },
title: { contains: q, mode: "insensitive" },
},
orderBy: { createdAt: "asc" },
});

if (!task) {
await bot.sendMessage(chatId, `No encontré tarea que coincida con: "${cmd.payload}"`);
return;
}

await prisma.task.update({
where: { id: task.id },
data: { status: "DONE" },
});

await bot.sendMessage(chatId, `✅ Marcada como DONE: ${task.title}`);
return;
}

// Help / fallback
await bot.sendMessage(
chatId,
[
"Muëcy Ops 🤖",
"",
"Comandos:",
"• tarea: cortar fillers cocina / Producción / high",
"• top",
"• hoy",
"• done: fillers",
"",
"Evento (Google Calendar):",
"• event: visita eddy / mañana 5pm / 60 / loc: Miami / desc: medir cocina / task: enviar estimate",
"• invite: a@b.com,b@c.com (puede ignorarse si el service account no puede invitar)",
].join("\n")
);
});

return bot;
}
