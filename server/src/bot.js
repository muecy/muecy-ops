import TelegramBot from "node-telegram-bot-api";
import { prisma } from "./db.js";
import { parseCommand, normalizePriority } from "./parse.js";

function splitParts(payload) {
  // "titulo / Rol / high / viernes" => parts
  return payload.split("/").map(s => s.trim()).filter(Boolean);
}

export function startBot({ userId }) {
  const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || "";

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
