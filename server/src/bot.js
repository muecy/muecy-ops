import TelegramBot from "node-telegram-bot-api";
import { prisma } from "./db.js";
import { parseCommand, normalizePriority } from "./parse.js";
import { google } from "googleapis";

function splitParts(payload) {
  // "titulo / Rol / high / viernes" => parts
  return payload.split("/").map(s => s.trim()).filter(Boolean);
  function pickField(str, key) {
  // key ejemplo: "loc", "desc", "invite", "task"
  const re = new RegExp(`\\b${key}\\s*:\\s*([^/]+)`, "i");
  const m = str.match(re);
  return m ? m[1].trim() : "";
}

function removeFields(str) {
  // Quita loc:/desc:/invite:/task: del texto principal
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
    .map(s => s.trim())
    .filter(Boolean)
    .map(email => ({ email }));
}
function getCalendarClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON");
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    // por si el JSON viene con \n literal
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

// Devuelve "YYYY-MM-DDTHH:mm:00" en hora local de NY (sin Z)
function parseWhenToNYLocal(whenText) {
  const tz = "America/New_York";
const nowNY = new Date(
  new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
);
let base = new Date(nowNY.getTime());
  const w = (whenText || "").toLowerCase();

  if (w.includes("mañana") || w.includes("manana") || w.includes("tomorrow")) {
    base.setDate(base.getDate() + 1);
  }

  // hora (ej: 3pm, 3:30pm, 15:00)
  const m = w.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) throw new Error('No pude leer la hora. Usa ejemplo: "mañana 3pm" o "2026-02-23 15:00"');

  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2] || "0", 10);
  const ampm = (m[3] || "").toLowerCase();

  if (ampm === "pm" && hh < 12) hh += 12;
  if (ampm === "am" && hh === 12) hh = 0;

  // Si el usuario puso fecha explícita YYYY-MM-DD
  const d = w.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (d) {
    const [_, Y, M, D] = d;
    return { tz, local: `${Y}-${M}-${D}T${pad2(hh)}:${pad2(mm)}:00` };
  }

  // Usamos la fecha de "base" (ojo: depende del server, pero luego fijamos timeZone NY)
  const Y = base.getFullYear();
  const M = pad2(base.getMonth() + 1);
  const D = pad2(base.getDate());
  return { tz, local: `${Y}-${M}-${D}T${pad2(hh)}:${pad2(mm)}:00` };
}

function addMinutesToLocal(local, minutes) {
  // local: YYYY-MM-DDTHH:mm:00
  const [datePart, timePart] = local.split("T");
  const [Y, M, D] = datePart.split("-").map(Number);
  const [hh, mm] = timePart.split(":").map(Number);

  const dt = new Date(Y, M - 1, D, hh, mm, 0);
  dt.setMinutes(dt.getMinutes() + minutes);

  const outY = dt.getFullYear();
  const outM = pad2(dt.getMonth() + 1);
  const outD = pad2(dt.getDate());
  const outH = pad2(dt.getHours());
  const outMin = pad2(dt.getMinutes());

  return `${outY}-${outM}-${outD}T${outH}:${outMin}:00`;
}
export function startBot({ userId }) {
  const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || "";
// ======================
// EVENT command (Google Calendar)
// Uso recomendado:
// event: Título / mañana 3pm / 60
// event: Título / 2026-02-23 15:00 / 90
// ======================
if (/^\/?event\b/i.test(text.trim())) {
  try {
    const calendarId = process.env.GOOGLE_CALENDAR_ID;
    if (!calendarId) throw new Error("Missing GOOGLE_CALENDAR_ID");

    // Acepta: "event: titulo / cuando / duración"
  const cleanedRaw = text.replace(/^\s*\/?event\b\s*:?\s*/i, "").trim();

const location = pickField(cleanedRaw, "loc");
const description = pickField(cleanedRaw, "desc");
const inviteRaw = pickField(cleanedRaw, "invite");
const taskRaw = pickField(cleanedRaw, "task");

const cleaned = removeFields(cleanedRaw);

const parts = cleaned.split("/").map(s => s.trim()).filter(Boolean);

    const title = parts[0] || "Evento Muëcy Ops";
    const whenText = parts[1] || "";
    const minutes = parseInt(parts[2] || "60", 10);

    const { tz, local } = parseWhenToNYLocal(whenText);
    const endLocal = addMinutesToLocal(local, Number.isFinite(minutes) ? minutes : 60);

const calendar = getCalendarClient();

const attendees = parseInviteList(inviteRaw);

const requestBody = {
  summary: title,
  start: { dateTime: local, timeZone: tz },
  end: { dateTime: endLocal, timeZone: tz },
  ...(location ? { location } : {}),
  ...(description ? { description } : {}),
  ...(attendees.length ? { attendees } : {}),
};

const result = await calendar.events.insert({
  calendarId,
  requestBody,
  sendUpdates: attendees.length ? "all" : "none",
});

    const link = result?.data?.htmlLink || "";
    await bot.sendMessage(chatId, `✅ Evento creado:\n${title}\n🕒 ${local} (${tz})\n${link}`);
  } catch (e) {
    await bot.sendMessage(chatId, `❌ No pude crear el evento. Detalle: ${e.message}`);
  }
  return;
}
    const cmd = parseCommand(text);

    if (cmd.type === "task") {
      const parts = splitParts(cmd.payload);
      const title = parts[0] || "(tarea sin título)";
      const assignee = parts[1] || null;
      const priority = normalizePriority(parts[2] || "");

      const task = await prisma.task.create({
        data: { userId, title, assignee, priority, source: "manual" }
      });

      bot.sendMessage(chatId, `✅ Tarea creada\n• ${task.title}\n• ${assignee ? `Rol: ${assignee}` : "Rol: (sin asignar)"}\n• Prioridad: P${task.priority}`);
      return;
    }

    if (cmd.type === "top") {
      const tasks = await prisma.task.findMany({
        where: { userId, status: { in: ["PENDING", "DOING", "BLOCKED"] } },
        orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
        take: 10
      });
      const lines = ["🔴 Top 10 tareas:", ...tasks.map(t => `- [P${t.priority}] ${t.title}`)];
      bot.sendMessage(chatId, lines.join("\n"));
      return;
    }

    if (cmd.type === "today") {
      const tasks = await prisma.task.findMany({
        where: { userId, status: { in: ["PENDING", "DOING", "BLOCKED"] } },
        orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
        take: 20
      });
      const lines = ["📌 Pendientes:", ...tasks.map(t => `- [${t.status}] [P${t.priority}] ${t.title}`)];
      bot.sendMessage(chatId, lines.join("\n"));
      return;
    }

    if (cmd.type === "done") {
      const q = cmd.payload.toLowerCase();
      const task = await prisma.task.findFirst({
        where: { userId, status: { in: ["PENDING", "DOING", "BLOCKED"] }, title: { contains: q, mode: "insensitive" } },
        orderBy: { createdAt: "asc" }
      });
      if (!task) {
        bot.sendMessage(chatId, `No encontré tarea que coincida con: "${cmd.payload}"`);
        return;
      }
      await prisma.task.update({ where: { id: task.id }, data: { status: "DONE" } });
      bot.sendMessage(chatId, `✅ Marcada como DONE: ${task.title}`);
      return;
    }

    bot.sendMessage(
      chatId,
      [
        "Muëcy Ops 🤖\n",
        "Comandos:",
        "• tarea: cortar fillers cocina / Producción / high",
        "• top",
        "• hoy",
        "• done: fillers",
      ].join("\n")
    );
  });

  return bot;
}
