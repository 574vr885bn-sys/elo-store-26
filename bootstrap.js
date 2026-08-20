// Production bootstrap: loads the existing server and then attaches the new platform features.
const Module = require("module");
const originalLoad = Module._load;
let capturedApp = null;
let capturedDb = null;

Module._load = function(request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments);
  if (request === "express") {
    const wrapped = function(...args) {
      const app = loaded(...args);
      capturedApp = app;
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

if (!capturedApp || !capturedDb) throw new Error("Elo Store bootstrap: não foi possível ligar às instâncias do servidor.");
const { initEnhancements } = require("./enhancements");

// Separate stateless admin authentication for the extended panel.
const crypto = require("crypto");
function adminV2(req,res,next) {
  const raw = String(req.headers["x-admin-key"] || "");
  const expected = String(process.env.ADMIN_PANEL_KEY || "");
  if (!expected || raw.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(raw), Buffer.from(expected))) {
    return res.status(401).json({error:"Não autorizado."});
  }
  next();
}
initEnhancements(capturedApp, capturedDb, adminV2);
console.log("Elo Store: funcionalidades avançadas carregadas");
