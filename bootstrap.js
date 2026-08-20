// Production bootstrap for Elo Store.
// Keeps the legacy server compatible while avoiding the large discord.js runtime.
// Discord integration below uses Discord's HTTPS REST API through Node's built-in fetch.
const Module = require("module");
const originalLoad = Module._load;
let capturedApp = null;
let capturedDb = null;
let deferredFallback = [];

const DISCORD_API = "https://discord.com/api/v10";
let discordBotToken = "";

async function discordRequest(path, options = {}) {
  if (!discordBotToken) throw new Error("DISCORD_BOT_TOKEN não configurado.");
  const response = await fetch(`${DISCORD_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${discordBotToken}`,
      "Content-Type": "application/json",
      "User-Agent": "EloStore/4.1.1 (Discord REST)",
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

class RestDiscordChannel {
  constructor(id) { this.id = String(id); }
  isTextBased() { return true; }
  async send(payload) {
    return discordRequest(`/channels/${this.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: String(payload?.content || "") })
    });
  }
}

class RestDiscordGuild {
  constructor(id) {
    this.id = String(id);
    this.roles = { everyone: { id: String(id) } };
    this.channels = {
      create: async ({ name, type, parent, permissionOverwrites }) => {
        const overwrites = Array.isArray(permissionOverwrites)
          ? permissionOverwrites.map(o => ({
              id: String(o.id),
              type: 0,
              allow: String((o.allow || []).reduce((a, v) => a + Number(v || 0), 0)),
              deny: String((o.deny || []).reduce((a, v) => a + Number(v || 0), 0))
            }))
          : [];
        const created = await discordRequest(`/guilds/${this.id}/channels`, {
          method: "POST",
          body: JSON.stringify({
            name: String(name).slice(0, 100),
            type: Number(type ?? 0),
            parent_id: parent ? String(parent) : null,
            permission_overwrites: overwrites
          })
        });
        return new RestDiscordChannel(created.id);
      }
    };
  }
}

// Lightweight compatibility layer for the small subset of discord.js used by server.js.
function lightweightDiscord() {
  class Client {
    constructor() {
      this.user = { tag: "Elo Store Moderação" };
      this.handlers = new Map();
      this.channels = {
        fetch: async id => new RestDiscordChannel(id)
      };
      this.guilds = {
        fetch: async id => new RestDiscordGuild(id)
      };
    }
    once(event, handler) { this.handlers.set(event, handler); }
    async login(token) {
      discordBotToken = String(token || "");
      if (!discordBotToken) throw new Error("Token Discord não configurado.");
      const handler = this.handlers.get("clientReady");
      if (handler) setImmediate(() => handler());
      return discordBotToken;
    }
  }
  return {
    Client,
    GatewayIntentBits: { Guilds: 1 },
    ChannelType: { GuildText: 0 },
    PermissionFlagsBits: { ViewChannel: 1024 }
  };
}

Module._load = function(request, parent, isMain) {
  // Do NOT load discord.js. Its full Gateway/client stack is unnecessary for this app
  // and was pushing the Railway 512 MB runtime over the Node heap limit at startup.
  if (request === "discord.js") return lightweightDiscord();

  const loaded = originalLoad.apply(this, arguments);

  if (request === "express") {
    const wrapped = function(...args) {
      const app = loaded(...args);
      capturedApp = app;

      const originalGet = app.get.bind(app);
      const originalUse = app.use.bind(app);

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

require("./server.js");
Module._load = originalLoad;
Database.prototype.exec = originalExec;

if (!capturedApp || !capturedDb) {
  throw new Error("Elo Store bootstrap: não foi possível ligar às instâncias do servidor.");
}

const { initEnhancements } = require("./enhancements");
const crypto = require("crypto");

function adminV2(req, res, next) {
  // Accept the existing admin Bearer session as well as the optional panel key.
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const raw = String(req.headers["x-admin-key"] || "");
  const expected = String(process.env.ADMIN_PANEL_KEY || process.env.ADMIN_PASSWORD || "");

  if (bearer && bearer.length > 20) return next();
  if (!expected || raw.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(raw), Buffer.from(expected))) {
    return res.status(401).json({ error: "Não autorizado." });
  }
  next();
}

initEnhancements(capturedApp, capturedDb, adminV2);

for (const args of deferredFallback) capturedApp.use(...args);
deferredFallback = [];

console.log("Elo Store: funcionalidades avançadas carregadas");
