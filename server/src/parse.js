// Simple command parser for Telegram
// Examples:
//  tarea: cortar fillers cocina / Producción / high / viernes
//  hoy
//  top
//  done: fillers

export function parseCommand(text) {
  const t = (text || "").trim();
  const low = t.toLowerCase();

  if (low === "hoy") return { type: "today" };
  if (low === "top") return { type: "top" };

  if (low.startsWith("done:")) {
    return { type: "done", payload: t.slice(5).trim() };
  }

  if (low.startsWith("tarea:")) {
    return { type: "task", payload: t.slice(6).trim() };
  }

  if (low.startsWith("agenda:")) {
    return { type: "event", payload: t.slice(7).trim() };
  }

  return { type: "help" };
}

export function normalizePriority(s) {
  const low = (s || "").toLowerCase();
  if (low.includes("high") || low.includes("alta") || low.includes("p1")) return 1;
  if (low.includes("low") || low.includes("baja") || low.includes("p3")) return 3;
  return 2;
}
