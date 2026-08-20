require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const Database = require("better-sqlite3");
const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } = require("discord.js");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const UPLOADS = path.join(DATA, "uploads");
fs.mkdirSync(UPLOADS, { recursive: true });

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC));

app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(PUBLIC, "admin.html"));
});

const db = new Database(path.join(DATA, "elo-store.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Robux',
  price REAL NOT NULL,
  description TEXT NOT NULL,
  info TEXT DEFAULT '',
  stock INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  discord TEXT NOT NULL,
  roblox TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pendente',
  payment_method TEXT DEFAULT '',
  proof_path TEXT DEFAULT '',
  coupon TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL,
  name TEXT NOT NULL,
  rating INTEGER NOT NULL,
  text TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  discount_percent REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'info',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS site_settings (
  id INTEGER PRIMARY KEY CHECK (id=1),
  maintenance INTEGER NOT NULL DEFAULT 0,
  maintenance_title TEXT NOT NULL DEFAULT 'Estamos em manutenção',
  maintenance_message TEXT NOT NULL DEFAULT 'Estamos a atualizar a Elo Store. Voltamos já.',
  announcement_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
db.prepare(`INSERT OR IGNORE INTO site_settings (id) VALUES (1)`).run();

const count = db.prepare("SELECT COUNT(*) c FROM products").get().c;
if (!count) {
  const insert = db.prepare(`INSERT INTO products
    (name, category, price, description, info, stock) VALUES (?, ?, ?, ?, ?, ?)`);
  const products = [
    ["500 Robux","Robux",17.50,"Pacote de 500 Robux.","Entrega digital após confirmação do pagamento.",100],
    ["1.000 Robux","Robux",27.50,"Pacote de 1.000 Robux.","Entrega digital após confirmação do pagamento.",100],
    ["2.000 Robux","Robux",47.50,"Pacote de 2.000 Robux.","Entrega digital após confirmação do pagamento.",100],
    ["3.000 Robux","Robux",67.50,"Pacote de 3.000 Robux.","Entrega digital após confirmação do pagamento.",100],
    ["4.000 Robux","Robux",87.50,"Pacote de 4.000 Robux.","Entrega digital após confirmação do pagamento.",100],
    ["5.000 Robux","Robux",104.99,"Pacote de 5.000 Robux.","Entrega digital após confirmação do pagamento.",100],
    ["6.000 Robux","Robux",124.99,"Pacote de 6.000 Robux.","Entrega digital após confirmação do pagamento.",100],
    ["7.000 Robux","Robux",144.99,"Pacote de 7.000 Robux.","Entrega digital após confirmação do pagamento.",100],
    ["8.000 Robux","Robux",164.99,"Pacote de 8.000 Robux.","Entrega digital após confirmação do pagamento.",100],
    ["9.000 Robux","Robux",184.99,"Pacote de 9.000 Robux.","Entrega digital após confirmação do pagamento.",100],
    ["10.000 Robux","Robux",204.99,"Pacote de 10.000 Robux.","Entrega digital após confirmação do pagamento.",100]
  ];
  const tx = db.transaction(() => products.forEach(p => insert.run(...p)));
  tx();
  db.prepare("INSERT OR IGNORE INTO coupons (code, discount_percent) VALUES (?, ?)").run("ELO10",10);
}

const upload = multer({
  dest: UPLOADS,
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 5) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ["image/png","image/jpeg","image/webp","application/pdf"].includes(file.mimetype);
    cb(ok ? null : new Error("Formato não suportado. Usa PNG, JPG, WEBP ou PDF."));
  }
});

const sessions = new Map();
function newToken() { return crypto.randomBytes(32).toString("hex"); }
function admin(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i,"");
  const expires = token ? sessions.get(token) : null;
  if (!expires) return res.status(401).json({ error: "Não autorizado." });
  if (Date.now() > expires) {
    sessions.delete(token);
    return res.status(401).json({ error: "Sessão expirada." });
  }
  next();
}
function orderNumber() {
  let n;
  do { n = `ELO-${Math.floor(10000 + Math.random()*90000)}`; }
  while (db.prepare("SELECT 1 FROM orders WHERE order_number=?").get(n));
  return n;
}
function cleanProduct(p) {
  return {...p, active: !!p.active, available: !!p.active && p.stock > 0};
}

app.get("/api/config", (req,res) => res.json({
  pix: process.env.PIX_KEY || "Configura a tua chave PIX no .env",
  paypal: process.env.PAYPAL_EMAIL || "Configura o PayPal no .env"
}));

app.get("/api/products", (req,res) => {
  const rows = db.prepare("SELECT * FROM products WHERE active=1 ORDER BY id").all();
  res.json(rows.map(cleanProduct));
});
app.get("/api/products/:id", (req,res) => {
  const p = db.prepare("SELECT * FROM products WHERE id=? AND active=1").get(req.params.id);
  if (!p) return res.status(404).json({error:"Produto não encontrado."});
  res.json(cleanProduct(p));
});

app.post("/api/coupon", (req,res) => {
  const code = String(req.body.code || "").trim().toUpperCase();
  const c = db.prepare("SELECT * FROM coupons WHERE code=? AND active=1").get(code);
  if (!c) return res.status(404).json({error:"Código promocional inválido."});
  res.json({code:c.code, discountPercent:c.discount_percent});
});

app.post("/api/orders", upload.single("proof"), (req,res) => {
  try {
    const { customerName, discord, roblox, productId, quantity, paymentMethod, coupon } = req.body;
    const qty = Math.max(1, Math.min(20, Number(quantity || 1)));
    if (!customerName || !discord || !roblox || !productId) return res.status(400).json({error:"Preenche todos os campos obrigatórios."});
    const product = db.prepare("SELECT * FROM products WHERE id=? AND active=1").get(productId);
    if (!product) return res.status(404).json({error:"Produto não encontrado."});
    if (product.stock < qty) return res.status(400).json({error:"Stock insuficiente."});
    let total = product.price * qty;
    let discount = 0;
    const couponCode = String(coupon || "").trim().toUpperCase();
    if (couponCode) {
      const c = db.prepare("SELECT * FROM coupons WHERE code=? AND active=1").get(couponCode);
      if (c) { discount = total * (c.discount_percent/100); total -= discount; }
    }
    const number = orderNumber();
    let proof = "";
    if (req.file) proof = path.basename(req.file.path);
    db.prepare(`INSERT INTO orders
      (order_number,customer_name,discord,roblox,product_id,quantity,total,payment_method,proof_path,coupon)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        number, customerName.trim(), discord.trim(), roblox.trim(), product.id, qty,
        Number(total.toFixed(2)), paymentMethod || "", proof, couponCode
    );
    db.prepare("UPDATE products SET stock=stock-? WHERE id=?").run(qty, product.id);
    const order = db.prepare(`SELECT o.*, p.name product_name FROM orders o JOIN products p ON p.id=o.product_id WHERE o.order_number=?`).get(number);
    notifyDiscord(order).catch(console.error);
    res.json({ok:true, order});
  } catch (e) {
    res.status(400).json({error:e.message || "Não foi possível criar o pedido."});
  }
});

app.get("/api/orders/:number", (req,res) => {
  const o = db.prepare(`SELECT o.order_number,o.customer_name,o.discord,o.roblox,o.quantity,o.total,o.status,
    o.payment_method,o.coupon,o.created_at,o.updated_at,p.name product_name
    FROM orders o JOIN products p ON p.id=o.product_id WHERE o.order_number=?`).get(req.params.number);
  if (!o) return res.status(404).json({error:"Pedido não encontrado."});
  res.json(o);
});

app.get("/api/reviews", (req,res) => res.json(db.prepare("SELECT id,name,rating,text,created_at FROM reviews WHERE approved=1 ORDER BY id DESC LIMIT 50").all()));
app.post("/api/reviews", (req,res) => {
  const {orderNumber,name,rating,text}=req.body;
  const o=db.prepare("SELECT 1 FROM orders WHERE order_number=?").get(orderNumber);
  if(!o) return res.status(400).json({error:"Número de pedido inválido."});
  const r=Math.max(1,Math.min(5,Number(rating)));
  if(!name || !text) return res.status(400).json({error:"Preenche o nome e a avaliação."});
  db.prepare("INSERT INTO reviews(order_number,name,rating,text) VALUES(?,?,?,?)").run(orderNumber,name.trim(),r,text.trim());
  res.json({ok:true});
});


// Site / anúncios

app.get("/", (req,res,next) => {
  const s = db.prepare("SELECT * FROM site_settings WHERE id=1").get();
  if (s && s.maintenance) return res.sendFile(path.join(PUBLIC, "maintenance.html"));
  next();
});
app.get("/api/site-config", (req,res) => {
  const settings = db.prepare("SELECT * FROM site_settings WHERE id=1").get();
  const now = new Date().toISOString();
  const announcements = db.prepare(`
    SELECT id,title,message,type,created_at,expires_at
    FROM announcements
    WHERE active=1
      AND (expires_at IS NULL OR expires_at='' OR expires_at>?)
    ORDER BY id DESC
    LIMIT 10
  `).all(now);
  res.json({
    maintenance: !!settings.maintenance,
    maintenanceTitle: settings.maintenance_title,
    maintenanceMessage: settings.maintenance_message,
    announcementEnabled: !!settings.announcement_enabled,
    announcements
  });
});

// Admin
app.post("/api/admin/login",(req,res)=>{
  const user=String(req.body.username||"");
  const pass=String(req.body.password||"");
  if(user !== (process.env.ADMIN_USERNAME || "admin") || pass !== (process.env.ADMIN_PASSWORD || "change-me"))
    return res.status(401).json({error:"Credenciais inválidas."});
  const token=newToken(); sessions.set(token, Date.now()+1000*60*60*12);
  res.json({token});
});
app.get("/api/admin/orders",admin,(req,res)=>{
  res.json(db.prepare(`SELECT o.*,p.name product_name FROM orders o JOIN products p ON p.id=o.product_id ORDER BY o.id DESC`).all());
});
app.patch("/api/admin/orders/:id",admin,(req,res)=>{
  const allowed=["Pendente","Pago","Em processamento","Entregue"];
  const status=String(req.body.status||"");
  if(!allowed.includes(status)) return res.status(400).json({error:"Estado inválido."});
  const o=db.prepare("SELECT * FROM orders WHERE id=?").get(req.params.id);
  if(!o) return res.status(404).json({error:"Pedido não encontrado."});
  db.prepare("UPDATE orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(status,o.id);
  const updated=db.prepare(`SELECT o.*,p.name product_name FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=?`).get(o.id);
  notifyDiscord(updated).catch(console.error);
  res.json(updated);
});
app.get("/api/admin/products",admin,(req,res)=>res.json(db.prepare("SELECT * FROM products ORDER BY id").all()));
app.patch("/api/admin/products/:id",admin,(req,res)=>{
  const p=db.prepare("SELECT * FROM products WHERE id=?").get(req.params.id);
  if(!p) return res.status(404).json({error:"Produto não encontrado."});
  const price = Number(req.body.price ?? p.price);
  const stock = Math.max(0, Number(req.body.stock ?? p.stock));
  const active = req.body.active === undefined ? p.active : (req.body.active ? 1 : 0);
  db.prepare("UPDATE products SET price=?,stock=?,active=? WHERE id=?").run(price,stock,active,p.id);
  res.json(db.prepare("SELECT * FROM products WHERE id=?").get(p.id));
});
app.get("/api/admin/stats",admin,(req,res)=>{
  const total=db.prepare("SELECT COUNT(*) c FROM orders").get().c;
  const pending=db.prepare("SELECT COUNT(*) c FROM orders WHERE status='Pendente'").get().c;
  const processing=db.prepare("SELECT COUNT(*) c FROM orders WHERE status='Em processamento'").get().c;
  const delivered=db.prepare("SELECT COUNT(*) c FROM orders WHERE status='Entregue'").get().c;
  const revenue=db.prepare("SELECT COALESCE(SUM(total),0) s FROM orders WHERE status!='Pendente'").get().s;
  res.json({total,pending,processing,delivered,revenue});
});
app.get("/api/admin/proof/:file",admin,(req,res)=>{
  const file=path.basename(req.params.file);
  const full=path.join(UPLOADS,file);
  if(!fs.existsSync(full)) return res.status(404).end();
  res.sendFile(full);
});


// Administração do site
app.get("/api/admin/site", admin, (req,res) => {
  res.json(db.prepare("SELECT * FROM site_settings WHERE id=1").get());
});

app.patch("/api/admin/site", admin, (req,res) => {
  const current = db.prepare("SELECT * FROM site_settings WHERE id=1").get();
  const maintenance = req.body.maintenance === undefined ? current.maintenance : (req.body.maintenance ? 1 : 0);
  const announcementEnabled = req.body.announcement_enabled === undefined
    ? current.announcement_enabled
    : (req.body.announcement_enabled ? 1 : 0);
  const title = String(req.body.maintenance_title ?? current.maintenance_title).trim().slice(0,120);
  const message = String(req.body.maintenance_message ?? current.maintenance_message).trim().slice(0,500);
  db.prepare(`UPDATE site_settings
    SET maintenance=?, maintenance_title=?, maintenance_message=?, announcement_enabled=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=1`).run(maintenance, title || current.maintenance_title, message || current.maintenance_message, announcementEnabled);
  res.json(db.prepare("SELECT * FROM site_settings WHERE id=1").get());
});

app.get("/api/admin/announcements", admin, (req,res) => {
  res.json(db.prepare("SELECT * FROM announcements ORDER BY id DESC").all());
});

app.post("/api/admin/announcements", admin, (req,res) => {
  const title = String(req.body.title || "").trim();
  const message = String(req.body.message || "").trim();
  const type = ["info","success","warning","danger"].includes(req.body.type) ? req.body.type : "info";
  const expiresAt = String(req.body.expires_at || "").trim();
  if (!title || !message) return res.status(400).json({error:"Preenche o título e a mensagem."});
  const r = db.prepare("INSERT INTO announcements(title,message,type,expires_at) VALUES(?,?,?,?)")
    .run(title.slice(0,120), message.slice(0,1000), type, expiresAt);
  res.json(db.prepare("SELECT * FROM announcements WHERE id=?").get(r.lastInsertRowid));
});

app.patch("/api/admin/announcements/:id", admin, (req,res) => {
  const a = db.prepare("SELECT * FROM announcements WHERE id=?").get(req.params.id);
  if (!a) return res.status(404).json({error:"Anúncio não encontrado."});
  const active = req.body.active === undefined ? a.active : (req.body.active ? 1 : 0);
  db.prepare("UPDATE announcements SET active=? WHERE id=?").run(active, a.id);
  res.json(db.prepare("SELECT * FROM announcements WHERE id=?").get(a.id));
});

app.delete("/api/admin/announcements/:id", admin, (req,res) => {
  db.prepare("DELETE FROM announcements WHERE id=?").run(req.params.id);
  res.json({ok:true});
});

app.get("/api/admin/reviews", admin, (req,res) => {
  res.json(db.prepare("SELECT * FROM reviews ORDER BY id DESC").all());
});

app.patch("/api/admin/reviews/:id", admin, (req,res) => {
  const r = db.prepare("SELECT * FROM reviews WHERE id=?").get(req.params.id);
  if (!r) return res.status(404).json({error:"Avaliação não encontrada."});
  const approved = req.body.approved ? 1 : 0;
  db.prepare("UPDATE reviews SET approved=? WHERE id=?").run(approved, r.id);
  res.json(db.prepare("SELECT * FROM reviews WHERE id=?").get(r.id));
});

app.get("/api/admin/coupons", admin, (req,res) => {
  res.json(db.prepare("SELECT * FROM coupons ORDER BY id DESC").all());
});

app.post("/api/admin/coupons", admin, (req,res) => {
  const code = String(req.body.code || "").trim().toUpperCase();
  const discount = Number(req.body.discount_percent);
  if (!code || !Number.isFinite(discount) || discount <= 0 || discount > 100)
    return res.status(400).json({error:"Indica um código e um desconto entre 1 e 100%."});
  try {
    const r = db.prepare("INSERT INTO coupons(code,discount_percent) VALUES(?,?)").run(code, discount);
    res.json(db.prepare("SELECT * FROM coupons WHERE id=?").get(r.lastInsertRowid));
  } catch {
    res.status(409).json({error:"Esse cupão já existe."});
  }
});

app.patch("/api/admin/coupons/:id", admin, (req,res) => {
  const c = db.prepare("SELECT * FROM coupons WHERE id=?").get(req.params.id);
  if (!c) return res.status(404).json({error:"Cupão não encontrado."});
  const active = req.body.active === undefined ? c.active : (req.body.active ? 1 : 0);
  const discount = req.body.discount_percent === undefined ? c.discount_percent : Number(req.body.discount_percent);
  if (!Number.isFinite(discount) || discount < 0 || discount > 100) return res.status(400).json({error:"Desconto inválido."});
  db.prepare("UPDATE coupons SET active=?,discount_percent=? WHERE id=?").run(active, discount, c.id);
  res.json(db.prepare("SELECT * FROM coupons WHERE id=?").get(c.id));
});

app.delete("/api/admin/coupons/:id", admin, (req,res) => {
  db.prepare("DELETE FROM coupons WHERE id=?").run(req.params.id);
  res.json({ok:true});
});

app.post("/api/admin/products", admin, (req,res) => {
  const name = String(req.body.name || "").trim();
  const category = String(req.body.category || "Robux").trim();
  const price = Number(req.body.price);
  const description = String(req.body.description || "").trim();
  const info = String(req.body.info || "").trim();
  const stock = Math.max(0, Number(req.body.stock || 0));
  if (!name || !description || !Number.isFinite(price) || price < 0)
    return res.status(400).json({error:"Dados do produto inválidos."});
  const r = db.prepare(`INSERT INTO products(name,category,price,description,info,stock)
    VALUES(?,?,?,?,?,?)`).run(name,category,price,description,info,stock);
  res.json(db.prepare("SELECT * FROM products WHERE id=?").get(r.lastInsertRowid));
});

app.delete("/api/admin/products/:id", admin, (req,res) => {
  const p = db.prepare("SELECT * FROM products WHERE id=?").get(req.params.id);
  if (!p) return res.status(404).json({error:"Produto não encontrado."});
  db.prepare("UPDATE products SET active=0 WHERE id=?").run(p.id);
  res.json({ok:true});
});

// Discord integration
let discordClient=null;
async function initDiscord(){
  if(!process.env.DISCORD_BOT_TOKEN) return;
  discordClient=new Client({intents:[GatewayIntentBits.Guilds]});
  discordClient.once("clientReady",()=>console.log(`Discord ligado como ${discordClient.user.tag}`));
  await discordClient.login(process.env.DISCORD_BOT_TOKEN);
}
async function notifyDiscord(order){
  if(!discordClient || !process.env.DISCORD_ORDER_CHANNEL_ID) return;
  const ch=await discordClient.channels.fetch(process.env.DISCORD_ORDER_CHANNEL_ID).catch(()=>null);
  if(!ch || !ch.isTextBased()) return;
  await ch.send({
    content:`🛒 **Novo/Atualizado pedido ${order.order_number}**\n`+
      `**Cliente:** ${order.customer_name}\n**Discord:** ${order.discord}\n**Roblox:** ${order.roblox}\n`+
      `**Produto:** ${order.product_name} x${order.quantity}\n**Total:** R$ ${Number(order.total).toFixed(2)}\n**Estado:** ${order.status}`
  });
}
async function createTicket(order){
  if(!discordClient || !process.env.DISCORD_GUILD_ID || !process.env.DISCORD_TICKET_CATEGORY_ID) return null;
  const guild=await discordClient.guilds.fetch(process.env.DISCORD_GUILD_ID);
  const channel=await guild.channels.create({
    name:`ticket-${order.order_number.toLowerCase()}`,
    type:ChannelType.GuildText,
    parent:process.env.DISCORD_TICKET_CATEGORY_ID,
    permissionOverwrites:[{id:guild.roles.everyone.id,deny:[PermissionFlagsBits.ViewChannel]}]
  });
  await channel.send(`🎫 **Ticket do pedido ${order.order_number}**\nCliente: **${order.customer_name}**\nDiscord: **${order.discord}**\nRoblox: **${order.roblox}**\nProduto: **${order.product_name}**`);
  return channel.id;
}
app.post("/api/orders/:number/ticket",async(req,res)=>{
  const o=db.prepare(`SELECT o.*,p.name product_name FROM orders o JOIN products p ON p.id=o.product_id WHERE o.order_number=?`).get(req.params.number);
  if(!o) return res.status(404).json({error:"Pedido não encontrado."});
  try{
    const id=await createTicket(o);
    if(!id) return res.status(503).json({error:"Discord ainda não está configurado no servidor."});
    res.json({ok:true,channelId:id});
  }catch(e){res.status(500).json({error:"Não foi possível criar o ticket."});}
});

app.use((req,res,next)=>{
  if(req.path.startsWith("/api/")) return res.status(404).json({error:"Endpoint não encontrado."});
  if(req.method !== "GET") return next();
  res.sendFile(path.join(PUBLIC,"index.html"));
});

app.use((err,req,res,next)=>res.status(400).json({error:err.message || "Erro."}));

app.listen(PORT,()=>console.log(`Elo Store: http://localhost:${PORT}`));
initDiscord().catch(e=>console.error("Discord:",e.message));
