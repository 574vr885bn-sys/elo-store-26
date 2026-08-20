const http = require("http");
const path = require("path");
const Database = require("better-sqlite3");

const DISCORD_API = "https://discord.com/api/v10";
const DEFAULT_TICKET_CATEGORY_ID = "1538255344822788158";
const originalEnd = http.ServerResponse.prototype.end;

async function discordRequest(endpoint, options = {}) {
  const token = String(process.env.DISCORD_BOT_TOKEN || "");
  if (!token) throw new Error("DISCORD_BOT_TOKEN não configurado no Railway.");

  const response = await fetch(DISCORD_API + endpoint, {
    ...options,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!response.ok) {
    throw new Error(`Discord ${response.status}: ${data?.message || data?.raw || "erro"}`);
  }
  return data;
}

function openDb() {
  const db = new Database(path.join(process.cwd(), "data", "elo-store.db"));
  db.pragma("busy_timeout = 5000");
  return db;
}

async function createDiscordTicket(ticketNumber) {
  const categoryId = String(process.env.DISCORD_TICKET_CATEGORY_ID || DEFAULT_TICKET_CATEGORY_ID).trim();
  const db = openDb();

  try {
    const ticket = db.prepare(`
      SELECT t.*, c.name AS customer_name, c.email AS customer_email,
             c.discord AS customer_discord, c.roblox AS customer_roblox
      FROM tickets t
      LEFT JOIN customers c ON c.id=t.customer_id
      WHERE t.ticket_number=?
    `).get(ticketNumber);

    if (!ticket) throw new Error(`Ticket ${ticketNumber} não encontrado na base de dados.`);

    const category = await discordRequest(`/channels/${categoryId}`);
    const guildId = String(category.guild_id || "");
    if (!guildId) throw new Error("Não foi possível descobrir o servidor Discord através da categoria.");

    // Migration is safe on old databases and only runs once.
    try {
      db.prepare("ALTER TABLE tickets ADD COLUMN discord_channel_id TEXT DEFAULT ''").run();
    } catch {}

    const existing = db.prepare("SELECT discord_channel_id FROM tickets WHERE id=?").get(ticket.id);
    if (existing?.discord_channel_id) {
      console.log(`Discord: ${ticket.ticket_number} já está ligado a ${existing.discord_channel_id}.`);
      return existing.discord_channel_id;
    }

    const botUser = await discordRequest("/users/@me");
    const channel = await discordRequest(`/guilds/${guildId}/channels`, {
      method: "POST",
      body: JSON.stringify({
        name: `ticket-${ticket.ticket_number.toLowerCase()}`.slice(0, 100),
        type: 0,
        parent_id: categoryId,
        topic: `Elo Store • ${ticket.ticket_number} • ${ticket.customer_name || "Cliente"}`,
        reason: `Novo ticket ${ticket.ticket_number}`,
        permission_overwrites: [
          {
            id: String(botUser.id),
            type: 1,
            allow: "19456"
          }
        ]
      })
    });

    const content = [
      `🎫 **NOVO TICKET — ${ticket.ticket_number}**`,
      `**Cliente:** ${ticket.customer_name || "—"}`,
      `**Email:** ${ticket.customer_email || "—"}`,
      `**Discord:** ${ticket.customer_discord || "—"}`,
      `**Roblox:** ${ticket.customer_roblox || "—"}`,
      `**Assunto:** ${ticket.subject}`,
      `**Mensagem:** ${ticket.message}`,
      "",
      "📌 Este canal foi criado automaticamente pela Elo Store."
    ].join("\n");

    await discordRequest(`/channels/${channel.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content })
    });

    db.prepare("UPDATE tickets SET discord_channel_id=? WHERE id=?").run(String(channel.id), ticket.id);
    console.log(`Discord: ${ticket.ticket_number} criado na categoria ${categoryId}.`);
    return channel.id;
  } finally {
    db.close();
  }
}

async function syncTicketStatus(ticketId, status) {
  const db = openDb();
  try {
    try { db.prepare("ALTER TABLE tickets ADD COLUMN discord_channel_id TEXT DEFAULT ''").run(); } catch {}
    const ticket = db.prepare("SELECT ticket_number, discord_channel_id FROM tickets WHERE id=?").get(ticketId);
    if (!ticket?.discord_channel_id) return;
    await discordRequest(`/channels/${ticket.discord_channel_id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: `🔔 **${ticket.ticket_number}** foi atualizado para **${status}**.` })
    });
  } finally {
    db.close();
  }
}

function inspectResponse(req, body) {
  const method = req?.method || "";
  const url = String(req?.url || "");
  if (!body) return;

  if (method === "POST" && url.startsWith("/api/account/tickets")) {
    try {
      const payload = JSON.parse(body);
      if (payload?.ok && payload?.ticketNumber) {
        setImmediate(() => {
          createDiscordTicket(String(payload.ticketNumber)).catch(error => {
            console.error("Discord ticket:", error.message);
          });
        });
      }
    } catch {}
    return;
  }

  const match = method === "PATCH" ? url.match(/^\/api\/admin\/tickets\/(\d+)(?:\?|$)/) : null;
  if (match) {
    try {
      const payload = JSON.parse(body);
      // The existing admin endpoint returns only {ok:true}; read the new status from the DB.
      const ticketId = Number(match[1]);
      setImmediate(() => {
        const db = openDb();
        try {
          const ticket = db.prepare("SELECT status FROM tickets WHERE id=?").get(ticketId);
          if (ticket) syncTicketStatus(ticketId, ticket.status).catch(error => console.error("Discord ticket status:", error.message));
        } finally { db.close(); }
      });
      void payload;
    } catch {}
  }
}

http.ServerResponse.prototype.end = function patchedEnd(chunk, encoding, callback) {
  let body = "";
  if (typeof chunk === "string") body = chunk;
  else if (Buffer.isBuffer(chunk)) body = chunk.toString("utf8");

  inspectResponse(this.req, body);
  return originalEnd.call(this, chunk, encoding, callback);
};

console.log(`Discord ticket hook: ativo (categoria ${DEFAULT_TICKET_CATEGORY_ID}).`);
