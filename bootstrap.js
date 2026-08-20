// Elo Store production bootstrap.
// Keeps the lightweight Discord REST integration and enforces account-only purchases.
const Module = require("module");
const originalLoad = Module._load;
let capturedApp = null;
let capturedDb = null;
let deferredFallback = [];

const DISCORD_API = "https://discord.com/api/v10";
const TICKET_CATEGORY_ID = String(process.env.DISCORD_TICKET_CATEGORY_ID || "1538255344822788158");
let discordBotToken = "";

async function discordRequest(path, options = {}) {
  if (!discordBotToken) throw new Error("DISCORD_BOT_TOKEN não configurado no Railway.");
  const response = await fetch(`${DISCORD_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${discordBotToken}`,
      "Content-Type": "application/json",
      "User-Agent": "EloStore/4.2.1 (Discord REST)",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!response.ok) {
    const detail = data?.message || data?.raw || `HTTP ${response.status}`;
    throw new Error(`Discord ${response.status}: ${detail}`);
  }
  return data;
}

async function createSupportTicketChannel(ticket, customer) {
  if (!discordBotToken) throw new Error("DISCORD_BOT_TOKEN não configurado no Railway.");
  const category = await discordRequest(`/channels/${TICKET_CATEGORY_ID}`);
  const guildId = String(category.guild_id || "");
  if (!guildId) throw new Error("A categoria de tickets não pertence a um servidor Discord válido.");

  const safeNumber = String(ticket.ticket_number).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 70);
  const channel = await discordRequest(`/guilds/${guildId}/channels`, {
    method: "POST",
    body: JSON.stringify({ name: `ticket-${safeNumber}`, type: 0, parent_id: TICKET_CATEGORY_ID })
  });

  const mention = String(process.env.DISCORD_TICKET_ROLE_ID || "").trim();
  const mentionText = mention ? `<@&${mention}>` : "@here";
  const content = [
    `${mentionText} 🎫 **NOVO TICKET — ${ticket.ticket_number}**`,
    `**Cliente:** ${customer.name}`,
    `**Email:** ${customer.email}`,
    `**Discord:** ${customer.discord || "Não indicado"}`,
    `**Roblox:** ${customer.roblox || "Não indicado"}`,
    `**Assunto:** ${ticket.subject}`,
    `**Mensagem:** ${ticket.message}`,
    "",
    "Elo Store • Suporte"
  ].join("\n");

  const message = await discordRequest(`/channels/${channel.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content,
      allowed_mentions: mention ? { parse: [], roles: [mention] } : { parse: ["everyone"] }
    })
  });
  return { channelId: String(channel.id), messageId: String(message.id || "") };
}

function customerFromRequest(req) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token || !capturedDb) return null;
  const session = capturedDb.prepare("SELECT customer_id FROM customer_sessions WHERE token=? AND expires_at>? ").get(token, Date.now());
  if (!session) return null;
  return capturedDb.prepare("SELECT * FROM customers WHERE id=? AND active=1").get(session.customer_id) || null;
}

function customerGuard(req, res, next) {
  const customer = customerFromRequest(req);
  if (!customer) return res.status(401).json({ error: "Tens de iniciar sessão para comprar." });
  req.customer = customer;

  const orderColumns = capturedDb.prepare("PRAGMA table_info(orders)").all().map(x => x.name);
  if (!orderColumns.includes("customer_id")) capturedDb.exec("ALTER TABLE orders ADD COLUMN customer_id INTEGER DEFAULT NULL");

  const originalJson = res.json.bind(res);
  res.json = function(payload) {
    try {
      if (payload && payload.order && payload.order.order_number) {
        capturedDb.prepare("UPDATE orders SET customer_id=? WHERE order_number=?").run(customer.id, payload.order.order_number);
      }
    } catch (error) {
      console.error("Order account link:", error.message);
    }
    return originalJson(payload);
  };
  next();
}

Module._load = function(request, parent, isMain) {
  if (request === "discord.js") {
    class Client { async login(token) { discordBotToken = String(token || ""); return discordBotToken; } once() {} }
    return {
      Client,
      GatewayIntentBits: { Guilds: 1 },
      ChannelType: { GuildText: 0 },
      PermissionFlagsBits: { ViewChannel: 1024 }
    };
  }

  const loaded = originalLoad.apply(this, arguments);
  if (request === "express") {
    const wrapped = function(...args) {
      const app = loaded(...args);
      capturedApp = app;
      const originalGet = app.get.bind(app);
      const originalUse = app.use.bind(app);
      const originalPost = app.post.bind(app);

      app.get = function(routeOrSetting, ...handlers) {
        if (routeOrSetting === "/api/orders/:number" && handlers.length) {
          handlers = [function(req, res) {
            if (!capturedDb) return res.status(503).json({ error: "Serviço ainda a iniciar." });
            const o = capturedDb.prepare(`
              SELECT o.order_number,o.quantity,o.total,o.status,o.payment_method,o.coupon,
                     o.created_at,o.updated_at,p.name product_name
              FROM orders o JOIN products p ON p.id=o.product_id
              WHERE o.order_number=?
            `).get(req.params.number);
            if (!o) return res.status(404).json({ error: "Pedido não encontrado." });
            res.json(o);
          }];
        }
        return originalGet(routeOrSetting, ...handlers);
      };

      app.use = function(...args) {
        const fn = args[args.length - 1];
        if (typeof fn === "function") {
          const source = Function.prototype.toString.call(fn);
          const isLegacyApiFallback = source.includes("Endpoint não encontrado") && source.includes("req.path.startsWith(\"/api/\")");
          const isLegacyErrorHandler = source.includes("res.status(400).json") && source.includes("Erro.");
          if (isLegacyApiFallback || isLegacyErrorHandler) {
            deferredFallback.push(args);
            return app;
          }
        }
        return originalUse(...args);
      };

      app.post = function(routeOrSetting, ...handlers) {
        if (routeOrSetting === "/api/orders" && handlers.length) {
          return originalPost(routeOrSetting, customerGuard, ...handlers);
        }
        if (routeOrSetting === "/api/account/tickets") {
          return originalPost(routeOrSetting, async (req, res) => {
            const customer = customerFromRequest(req);
            if (!customer) return res.status(401).json({ error: "Inicia sessão para abrir um ticket." });
            const subject = String(req.body.subject || "").trim();
            const message = String(req.body.message || "").trim();
            if (subject.length < 3 || message.length < 3) return res.status(400).json({ error: "Preenche o assunto e a mensagem." });

            let ticketNumber;
            do { ticketNumber = `TKT-${Math.floor(10000 + Math.random() * 90000)}`; }
            while (capturedDb.prepare("SELECT 1 FROM tickets WHERE ticket_number=?").get(ticketNumber));

            const result = capturedDb.prepare("INSERT INTO tickets(ticket_number,customer_id,subject,message,status) VALUES(?,?,?,?,?)")
              .run(ticketNumber, customer.id, subject.slice(0,160), message.slice(0,5000), "Aberto");
            const ticketId = Number(result.lastInsertRowid);
            capturedDb.prepare("INSERT INTO ticket_messages(ticket_id,sender_type,message) VALUES(?,?,?)")
              .run(ticketId, "cliente", message.slice(0,5000));
            capturedDb.prepare("INSERT INTO customer_notifications(customer_id,title,message) VALUES(?,?,?)")
              .run(customer.id, "Ticket criado", `${ticketNumber}: recebemos o teu pedido de suporte.`);

            const cols = capturedDb.prepare("PRAGMA table_info(tickets)").all().map(x => x.name);
            if (!cols.includes("discord_channel_id")) capturedDb.exec("ALTER TABLE tickets ADD COLUMN discord_channel_id TEXT DEFAULT ''");
            if (!cols.includes("discord_message_id")) capturedDb.exec("ALTER TABLE tickets ADD COLUMN discord_message_id TEXT DEFAULT ''");

            let discord = null, discordError = "";
            try {
              discord = await createSupportTicketChannel({ ticket_number: ticketNumber, subject, message }, customer);
              capturedDb.prepare("UPDATE tickets SET discord_channel_id=?,discord_message_id=? WHERE id=?")
                .run(discord.channelId, discord.messageId, ticketId);
            } catch (error) {
              discordError = error.message || "Erro desconhecido no Discord.";
              console.error("Discord ticket:", discordError);
              capturedDb.prepare("INSERT INTO audit_log(action,target,details) VALUES(?,?,?)")
                .run("ticket.discord_error", ticketNumber, discordError);
            }

            capturedDb.prepare("INSERT INTO audit_log(action,target,details) VALUES(?,?,?)")
              .run("ticket.create", ticketNumber, customer.email);

            res.status(201).json({
              ok: true,
              ticketNumber,
              discord: discord ? { connected: true, channelId: discord.channelId } : { connected: false, error: discordError }
            });
          });
        }
        return originalPost(routeOrSetting, ...handlers);
      };

      return app;
    };
    Object.assign(wrapped, loaded);
    wrapped.Router = loaded.Router;
    wrapped.json = loaded.json;
    wrapped.urlencoded = loaded.urlencoded;
    wrapped.static = loaded.static;
    return wrapped;
  }
  return loaded;
};

const Database = require("better-sqlite3");
const originalExec = Database.prototype.exec;
Database.prototype.exec = function(...args) {
  capturedDb = this;
  return originalExec.apply(this, args);
};

discordBotToken = String(process.env.DISCORD_BOT_TOKEN || "");

require("./server.js");
Module._load = originalLoad;
Database.prototype.exec = originalExec;

if (!capturedApp || !capturedDb) throw new Error("Elo Store bootstrap: não foi possível ligar às instâncias do servidor.");

const ticketColumns = capturedDb.prepare("PRAGMA table_info(tickets)").all().map(x => x.name);
if (ticketColumns.length) {
  if (!ticketColumns.includes("discord_channel_id")) capturedDb.exec("ALTER TABLE tickets ADD COLUMN discord_channel_id TEXT DEFAULT ''");
  if (!ticketColumns.includes("discord_message_id")) capturedDb.exec("ALTER TABLE tickets ADD COLUMN discord_message_id TEXT DEFAULT ''");
}

console.log("Elo Store: produção iniciada com contas, compras protegidas e tickets Discord");
