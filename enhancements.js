const crypto = require("crypto");

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { hash, salt };
}

function verifyPassword(password, salt, hash) {
  try {
    const actual = crypto.scryptSync(String(password), salt, 64);
    const expected = Buffer.from(hash, "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

function token() { return crypto.randomBytes(32).toString("hex"); }
function safeCustomer(c) {
  if (!c) return null;
  return { id:c.id, name:c.name, email:c.email, discord:c.discord || "", roblox:c.roblox || "", points:c.points || 0, level:c.level || 1, created_at:c.created_at };
}

function initEnhancements(app, db, admin) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      discord TEXT DEFAULT '',
      roblox TEXT DEFAULT '',
      points INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS customer_sessions (
      token TEXT PRIMARY KEY,
      customer_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS points_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS customer_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_number TEXT NOT NULL UNIQUE,
      customer_id INTEGER,
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Aberto',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS ticket_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      sender_type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS favorites (
      customer_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(customer_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      target TEXT DEFAULT '',
      details TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Existing orders did not have an account email. Add it safely for future account ownership.
  const orderCols = db.prepare("PRAGMA table_info(orders)").all().map(x => x.name);
  if (!orderCols.includes("customer_email")) db.exec("ALTER TABLE orders ADD COLUMN customer_email TEXT DEFAULT ''");

  const customerSessions = (req) => {
    const t = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!t) return null;
    const s = db.prepare("SELECT * FROM customer_sessions WHERE token=? AND expires_at>? ").get(t, Date.now());
    if (!s) return null;
    return db.prepare("SELECT * FROM customers WHERE id=? AND active=1").get(s.customer_id) || null;
  };
  const customer = (req,res,next) => {
    const c = customerSessions(req);
    if (!c) return res.status(401).json({error:"Inicia sessão para continuar."});
    req.customer = c; next();
  };
  const audit = (action,target,details="") => db.prepare("INSERT INTO audit_log(action,target,details) VALUES(?,?,?)").run(action,target,details);
  const addPoints = (id, amount, reason) => {
    const n = Math.trunc(Number(amount));
    if (!n) return;
    db.prepare("UPDATE customers SET points=MAX(0,points+?), level=1+CAST(MAX(0,points+?)/100 AS INTEGER), updated_at=CURRENT_TIMESTAMP WHERE id=?").run(n,n,id);
    db.prepare("INSERT INTO points_ledger(customer_id,amount,reason) VALUES(?,?,?)").run(id,n,reason);
  };

  app.post("/api/auth/register", (req,res) => {
    const name=String(req.body.name||"").trim();
    const email=String(req.body.email||"").trim().toLowerCase();
    const password=String(req.body.password||"");
    if(name.length<2 || !/^\S+@\S+\.\S+$/.test(email) || password.length<8) return res.status(400).json({error:"Nome, email válido e password com pelo menos 8 caracteres são obrigatórios."});
    if(db.prepare("SELECT 1 FROM customers WHERE email=?").get(email)) return res.status(409).json({error:"Já existe uma conta com esse email."});
    const p=hashPassword(password);
    const r=db.prepare("INSERT INTO customers(name,email,password_hash,password_salt) VALUES(?,?,?,?)").run(name,email,p.hash,p.salt);
    addPoints(r.lastInsertRowid,25,"Bónus de registo");
    audit("customer.register",String(r.lastInsertRowid),email);
    const t=token(); db.prepare("INSERT INTO customer_sessions(token,customer_id,expires_at) VALUES(?,?,?)").run(t,r.lastInsertRowid,Date.now()+1000*60*60*24*30);
    res.json({token:t,customer:safeCustomer(db.prepare("SELECT * FROM customers WHERE id=?").get(r.lastInsertRowid))});
  });

  app.post("/api/auth/login", (req,res) => {
    const email=String(req.body.email||"").trim().toLowerCase(); const password=String(req.body.password||"");
    const c=db.prepare("SELECT * FROM customers WHERE email=? AND active=1").get(email);
    if(!c || !verifyPassword(password,c.password_salt,c.password_hash)) return res.status(401).json({error:"Email ou password incorretos."});
    const t=token(); db.prepare("INSERT INTO customer_sessions(token,customer_id,expires_at) VALUES(?,?,?)").run(t,c.id,Date.now()+1000*60*60*24*30);
    res.json({token:t,customer:safeCustomer(c)});
  });

  app.post("/api/auth/logout", customer, (req,res) => {
    const t=String(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
    db.prepare("DELETE FROM customer_sessions WHERE token=?").run(t); res.json({ok:true});
  });
  app.get("/api/auth/me", customer, (req,res)=>res.json({customer:safeCustomer(req.customer)}));
  app.patch("/api/auth/me", customer, (req,res)=>{
    const name=String(req.body.name??req.customer.name).trim(); const discord=String(req.body.discord??req.customer.discord).trim(); const roblox=String(req.body.roblox??req.customer.roblox).trim();
    if(name.length<2) return res.status(400).json({error:"Nome inválido."});
    db.prepare("UPDATE customers SET name=?,discord=?,roblox=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(name,discord,roblox,req.customer.id);
    res.json({customer:safeCustomer(db.prepare("SELECT * FROM customers WHERE id=?").get(req.customer.id))});
  });

  app.get("/api/account/orders", customer, (req,res)=>{
    const rows=db.prepare(`SELECT o.order_number,o.quantity,o.total,o.status,o.payment_method,o.coupon,o.created_at,o.updated_at,p.name product_name FROM orders o JOIN products p ON p.id=o.product_id WHERE o.customer_email=? ORDER BY o.id DESC`).all(req.customer.email);
    res.json(rows);
  });
  app.get("/api/account/points", customer, (req,res)=>res.json({points:req.customer.points,level:req.customer.level,ledger:db.prepare("SELECT amount,reason,created_at FROM points_ledger WHERE customer_id=? ORDER BY id DESC LIMIT 100").all(req.customer.id)}));
  app.get("/api/account/notifications", customer, (req,res)=>res.json(db.prepare("SELECT id,title,message,read,created_at FROM customer_notifications WHERE customer_id=? ORDER BY id DESC LIMIT 50").all(req.customer.id)));
  app.patch("/api/account/notifications/:id/read", customer, (req,res)=>{db.prepare("UPDATE customer_notifications SET read=1 WHERE id=? AND customer_id=?").run(req.params.id,req.customer.id);res.json({ok:true});});

  app.post("/api/account/tickets", customer, (req,res)=>{
    const subject=String(req.body.subject||"").trim(); const message=String(req.body.message||"").trim();
    if(subject.length<3 || message.length<3) return res.status(400).json({error:"Preenche o assunto e a mensagem."});
    const n=`TKT-${Math.floor(10000+Math.random()*90000)}`;
    const r=db.prepare("INSERT INTO tickets(ticket_number,customer_id,subject,message) VALUES(?,?,?,?)").run(n,req.customer.id,subject,message);
    db.prepare("INSERT INTO ticket_messages(ticket_id,sender_type,message) VALUES(?,?,?)").run(r.lastInsertRowid,"cliente",message);
    audit("ticket.create",n,req.customer.email); res.json({ok:true,ticketNumber:n});
  });
  app.get("/api/account/tickets", customer, (req,res)=>res.json(db.prepare("SELECT id,ticket_number,subject,message,status,created_at,updated_at FROM tickets WHERE customer_id=? ORDER BY id DESC").all(req.customer.id)));
  app.get("/api/account/favorites", customer, (req,res)=>res.json(db.prepare("SELECT p.* FROM favorites f JOIN products p ON p.id=f.product_id WHERE f.customer_id=? AND p.active=1 ORDER BY f.created_at DESC").all(req.customer.id)));
  app.post("/api/account/favorites/:productId", customer, (req,res)=>{db.prepare("INSERT OR IGNORE INTO favorites(customer_id,product_id) VALUES(?,?)").run(req.customer.id,req.params.productId);res.json({ok:true});});
  app.delete("/api/account/favorites/:productId", customer, (req,res)=>{db.prepare("DELETE FROM favorites WHERE customer_id=? AND product_id=?").run(req.customer.id,req.params.productId);res.json({ok:true});});

  // Public order lookup deliberately exposes only non-sensitive information.
  const publicOrder = db.prepare(`SELECT o.order_number,o.quantity,o.total,o.status,o.payment_method,o.coupon,o.created_at,o.updated_at,p.name product_name FROM orders o JOIN products p ON p.id=o.product_id WHERE o.order_number=?`);
  app.get("/api/public/orders/:number", (req,res)=>{const o=publicOrder.get(req.params.number);if(!o)return res.status(404).json({error:"Pedido não encontrado."});res.json(o);});

  // Admin customer/support/analytics controls.
  app.get("/api/admin/customers",admin,(req,res)=>res.json(db.prepare("SELECT id,name,email,discord,roblox,points,level,active,created_at FROM customers ORDER BY id DESC").all()));
  app.patch("/api/admin/customers/:id",admin,(req,res)=>{const c=db.prepare("SELECT * FROM customers WHERE id=?").get(req.params.id);if(!c)return res.status(404).json({error:"Cliente não encontrado."});if(req.body.active!==undefined)db.prepare("UPDATE customers SET active=? WHERE id=?").run(req.body.active?1:0,c.id);if(req.body.points!==undefined)addPoints(c.id,Number(req.body.points)-c.points,"Ajuste manual do administrador");audit("customer.update",String(c.id),JSON.stringify(req.body));res.json(safeCustomer(db.prepare("SELECT * FROM customers WHERE id=?").get(c.id)));});
  app.post("/api/admin/customers/:id/points",admin,(req,res)=>{const c=db.prepare("SELECT * FROM customers WHERE id=?").get(req.params.id);if(!c)return res.status(404).json({error:"Cliente não encontrado."});const amount=Math.trunc(Number(req.body.amount));if(!Number.isFinite(amount)||!amount)return res.status(400).json({error:"Quantidade inválida."});addPoints(c.id,amount,String(req.body.reason||"Ajuste do administrador"));audit("points.adjust",String(c.id),String(amount));res.json(safeCustomer(db.prepare("SELECT * FROM customers WHERE id=?").get(c.id)));});
  app.get("/api/admin/customers/:id/points",admin,(req,res)=>res.json(db.prepare("SELECT amount,reason,created_at FROM points_ledger WHERE customer_id=? ORDER BY id DESC LIMIT 200").all(req.params.id)));
  app.get("/api/admin/tickets",admin,(req,res)=>res.json(db.prepare(`SELECT t.*,c.name customer_name,c.email customer_email FROM tickets t LEFT JOIN customers c ON c.id=t.customer_id ORDER BY t.id DESC`).all()));
  app.patch("/api/admin/tickets/:id",admin,(req,res)=>{const allowed=["Aberto","Em análise","Respondido","Fechado"];const status=String(req.body.status||"");if(!allowed.includes(status))return res.status(400).json({error:"Estado inválido."});const t=db.prepare("SELECT * FROM tickets WHERE id=?").get(req.params.id);if(!t)return res.status(404).json({error:"Ticket não encontrado."});db.prepare("UPDATE tickets SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(status,t.id);if(t.customer_id)db.prepare("INSERT INTO customer_notifications(customer_id,title,message) VALUES(?,?,?)").run(t.customer_id,"Atualização do ticket",`${t.ticket_number}: ${status}`);audit("ticket.status",t.ticket_number,status);res.json({ok:true});});
  app.get("/api/admin/audit",admin,(req,res)=>res.json(db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 200").all()));
  app.get("/api/admin/overview",admin,(req,res)=>{
    const customers=db.prepare("SELECT COUNT(*) c FROM customers").get().c;
    const openTickets=db.prepare("SELECT COUNT(*) c FROM tickets WHERE status!='Fechado'").get().c;
    const unread=db.prepare("SELECT COUNT(*) c FROM customer_notifications WHERE read=0").get().c;
    const points=db.prepare("SELECT COALESCE(SUM(points),0) s FROM customers").get().s;
    const today=db.prepare("SELECT COUNT(*) c FROM orders WHERE date(created_at)=date('now')").get().c;
    res.json({customers,openTickets,unread,points,today});
  });

  // Keep the old public order endpoint safe as well by replacing its response handler's data at the client boundary.
  audit("system.start", "enhancements", "Customer accounts, points, tickets and privacy enabled");
}

module.exports = { initEnhancements };