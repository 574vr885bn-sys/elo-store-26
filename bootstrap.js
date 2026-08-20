// Production bootstrap: load the legacy server, then attach the extended platform features.
// The legacy server has a final catch-all middleware. We temporarily hold that middleware
// so the enhancement routes are registered before the catch-all is put back.
const Module = require("module");
const originalLoad = Module._load;
let capturedApp = null;
let capturedDb = null;
let deferredFallback = [];

Module._load = function(request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments);

  if (request === "express") {
    const wrapped = function(...args) {
      const app = loaded(...args);
      capturedApp = app;

      const originalGet = app.get.bind(app);
      const originalUse = app.use.bind(app);

      app.get = function(routeOrSetting, ...handlers) {
        // Keep public order lookup privacy-safe.
        if (routeOrSetting === "/api/orders/:number" && handlers.length) {
          handlers = [function(req,res) {
            if (!capturedDb) return res.status(503).json({error:"Serviço ainda a iniciar."});
            const o = capturedDb.prepare(`
              SELECT o.order_number,o.quantity,o.total,o.status,o.payment_method,o.coupon,
                     o.created_at,o.updated_at,p.name product_name
              FROM orders o JOIN products p ON p.id=o.product_id
              WHERE o.order_number=?
            `).get(req.params.number);
            if (!o) return res.status(404).json({error:"Pedido não encontrado."});
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

  if (request === "better-sqlite3") {
    const OriginalDB = loaded;
    function WrappedDB(...args) {
      const db = new OriginalDB(...args);
      capturedDb = db;
      return db;
    }
    WrappedDB.prototype = OriginalDB.prototype;
    Object.setPrototypeOf(WrappedDB, OriginalDB);
    return WrappedDB;
  }

  return loaded;
};

require("./server.js");
Module._load = originalLoad;

if (!capturedApp || !capturedDb) {
  throw new Error("Elo Store bootstrap: não foi possível ligar às instâncias do servidor.");
}

const { initEnhancements } = require("./enhancements");
const crypto = require("crypto");

function adminV2(req,res,next) {
  const raw = String(req.headers["x-admin-key"] || "");
  const expected = String(process.env.ADMIN_PANEL_KEY || process.env.ADMIN_PASSWORD || "");
  if (!expected || raw.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(raw), Buffer.from(expected))) {
    return res.status(401).json({error:"Não autorizado."});
  }
  next();
}

initEnhancements(capturedApp, capturedDb, adminV2);

// Put the legacy fallback LAST, after all enhancement routes.
for (const args of deferredFallback) capturedApp.use(...args);
deferredFallback = [];

console.log("Elo Store: funcionalidades avançadas carregadas");
