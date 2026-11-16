// Vercel serverless function: forwards chat messages to Groq with the Doc persona.
// The key is read from the GROQ_API_KEY environment variable and never sent to the browser.
const fs = require("fs");
const path = require("path");

const MODEL = "openai/gpt-oss-120b";
const MAX_MESSAGES = 12;        // history kept per request
const MAX_CHARS = 2000;         // per user message
const WINDOW_MS = 60 * 1000;    // rate-limit window
const MAX_PER_WINDOW = 10;      // requests per IP per window
// ponytail: in-memory limiter, resets on cold start; upgrade to a KV store if abuse appears.
const hits = new Map();

// PERSONA (env var) overrides the bundled generic prompt. Keep trial personas in env vars only.
const SYSTEM = process.env.PERSONA || fs.readFileSync(path.join(__dirname, "system-prompt.txt"), "utf8");

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  return list.length > MAX_PER_WINDOW;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  if (!process.env.GROQ_API_KEY) {
    res.status(500).json({ error: "Server is not configured." });
    return;
  }
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) {
    res.status(429).json({ error: "Too many messages. Wait a minute and try again." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  // Passphrase gate: only enforced when ACCESS_PASSPHRASE is set.
  if (process.env.ACCESS_PASSPHRASE && (!body || body.passphrase !== process.env.ACCESS_PASSPHRASE)) {
    res.status(401).json({ error: "Wrong passphrase." });
    return;
  }
  const incoming = Array.isArray(body && body.messages) ? body.messages : [];
  const history = incoming
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  if (history.length === 0 || history[history.length - 1].role !== "user") {
    res.status(400).json({ error: "Send a user message." });
    return;
  }

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: SYSTEM }, ...history],
        temperature: 0.8,
        max_tokens: 700,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      res.status(502).json({ error: "The model service returned an error." });
      return;
    }
    const reply = data.choices && data.choices[0] && data.choices[0].message.content;
    res.status(200).json({ reply: reply || "" });
  } catch (e) {
    res.status(502).json({ error: "Could not reach the model service." });
  }
};
