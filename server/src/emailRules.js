// Muëcy Ops — Email classification rules

export function classifyEmail({ subject = "", from = "", snippet = "" }) {
  const text = `${subject} ${from} ${snippet}`.toLowerCase();

  // Hard filters / FYI
  const isNewsletter = /(unsubscribe|newsletter|promotion|no-reply|noreply)/.test(text);
  if (isNewsletter) {
    return { createTask: false, priority: 3, reason: "newsletter/fyi" };
  }

  // High priority keywords
  const high = /(invoice|deposit|payment|paid|urgent|asap|deadline|overdue|past due|balance due)/.test(text);
  if (high) return { createTask: true, priority: 1, reason: "payment/urgent" };

  // Medium priority keywords
  const medium = /(quote|estimate|confirm|approval|approve|schedule|meeting|call|revisión|revisar|confirmar)/.test(text);
  if (medium) return { createTask: true, priority: 2, reason: "action needed" };

  // Default: create a normal task (you asked: read all emails)
  return { createTask: true, priority: 2, reason: "default" };
}
