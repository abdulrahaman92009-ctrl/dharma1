const path = require("path");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.SESSION_SECRET;
if (!SECRET || SECRET.length < 32) {
  console.error("SESSION_SECRET must be set to a random value of at least 32 characters.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required. Configure PostgreSQL before starting.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",").map(x=>x.trim()) : true },
  maxHttpBufferSize: 1e5,
  pingInterval: 25000,
  pingTimeout: 20000
});
app.set("trust proxy", 1);
app.use(express.json({ limit: "16kb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

function sign(value) {
  return crypto.createHmac("sha256", SECRET).update(value).digest("hex");
}
function safeEqual(a,b) {
  const aa=Buffer.from(String(a||"")); const bb=Buffer.from(String(b||""));
  return aa.length===bb.length && crypto.timingSafeEqual(aa,bb);
}
function newGuest() { return "guest_" + crypto.randomBytes(12).toString("hex"); }
function getGuest(req) {
  const raw=req.cookies.guest_session || "";
  const split=raw.split(".");
  if(split.length===2 && /^[a-f0-9]{24,40}$/.test(split[0]) && safeEqual(split[1],sign(split[0]))) return split[0];
  return null;
}
function setGuest(res,id) {
  res.cookie("guest_session", `${id}.${sign(id)}`, {
    httpOnly:true, secure:process.env.NODE_ENV==="production",
    sameSite:"lax", maxAge:180*24*60*60*1000, path:"/"
  });
}
app.use((req,res,next)=>{
  let guest=getGuest(req);
  if(!guest){guest=newGuest();setGuest(res,guest);}
  req.guestId=guest;
  next();
});

const apiLimiter=rateLimit({windowMs:60_000,limit:120,standardHeaders:true,legacyHeaders:false,
  message:{error:"Too many requests. Please wait a moment and try again."}});
const messageLimiter=rateLimit({windowMs:60_000,limit:35,standardHeaders:true,legacyHeaders:false,
  message:{error:"Message rate limit reached. Please slow down."}});
app.use("/api",apiLimiter);

const cleanText=(v,max=500)=>typeof v==="string"?v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,"").trim().slice(0,max):"";
const roomSlug=v=>cleanText(v,40).toLowerCase().replace(/[^a-z0-9-]/g,"-").replace(/-+/g,"-").replace(/^-|-$/g,"");

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_rooms (
      id BIGSERIAL PRIMARY KEY,
      slug VARCHAR(40) UNIQUE NOT NULL,
      title VARCHAR(60) NOT NULL,
      created_by VARCHAR(48) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGSERIAL PRIMARY KEY,
      room_slug VARCHAR(40) NOT NULL REFERENCES chat_rooms(slug) ON DELETE CASCADE,
      guest_id VARCHAR(48) NOT NULL,
      display_name VARCHAR(32) NOT NULL,
      body VARCHAR(1000) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS chat_messages_room_id_idx ON chat_messages(room_slug,id DESC);
    CREATE INDEX IF NOT EXISTS chat_messages_created_idx ON chat_messages(created_at DESC);
  `);
  await pool.query(`INSERT INTO chat_rooms(slug,title,created_by) VALUES ('general','General','system') ON CONFLICT(slug) DO NOTHING`);
}

app.get("/health", async (_req,res)=>{
  try { await pool.query("SELECT 1"); res.json({ok:true,database:"connected"}); }
  catch { res.status(503).json({ok:false,database:"unavailable"}); }
});
app.get("/api/me",(req,res)=>res.json({guestId:req.guestId,displayName:`Guest-${req.guestId.slice(-5)}`}));
app.get("/api/rooms",async (_req,res)=>{
  const {rows}=await pool.query(`SELECT r.slug,r.title,r.created_at,
    (SELECT COUNT(*) FROM chat_messages m WHERE m.room_slug=r.slug)::int AS messages
    FROM chat_rooms r ORDER BY r.created_at ASC`);
  res.json(rows);
});
app.post("/api/rooms",async (req,res)=>{
  const title=cleanText(req.body?.title,60);
  const slug=roomSlug(title);
  if(!slug || slug.length<2) return res.status(400).json({error:"Room name must contain at least 2 letters or numbers."});
  try {
    const {rows}=await pool.query(
      "INSERT INTO chat_rooms(slug,title,created_by) VALUES($1,$2,$3) RETURNING slug,title,created_at",
      [slug,title,req.guestId]);
    res.status(201).json(rows[0]);
  } catch(e) {
    if(e.code==="23505") return res.status(409).json({error:"That room already exists."});
    console.error(e); res.status(500).json({error:"Could not create room."});
  }
});
app.get("/api/messages/:room",async (req,res)=>{
  const room=roomSlug(req.params.room);
  const exists=await pool.query("SELECT 1 FROM chat_rooms WHERE slug=$1",[room]);
  if(!exists.rowCount) return res.status(404).json({error:"Room not found."});
  const {rows}=await pool.query(
    `SELECT id,guest_id AS "guestId",display_name AS "displayName",body,
      created_at AS "createdAt" FROM (
       SELECT id,guest_id,display_name,body,created_at FROM chat_messages
       WHERE room_slug=$1 ORDER BY id DESC LIMIT 100
      ) recent ORDER BY id ASC`,[room]);
  res.json(rows);
});
app.get("/api/analytics",async (_req,res)=>{
  const [totals,activity,rooms]=await Promise.all([
    pool.query("SELECT COUNT(*)::int AS messages, COUNT(DISTINCT guest_id)::int AS guests FROM chat_messages"),
    pool.query(`SELECT TO_CHAR(day,'Dy') AS day, COALESCE(cnt,0)::int AS messages
      FROM generate_series(CURRENT_DATE-6,CURRENT_DATE,INTERVAL '1 day') day
      LEFT JOIN (SELECT DATE(created_at) d,COUNT(*) cnt FROM chat_messages WHERE created_at>=CURRENT_DATE-6 GROUP BY 1) a
      ON a.d=day::date ORDER BY day`),
    pool.query("SELECT COUNT(*)::int AS rooms FROM chat_rooms")
  ]);
  res.json({messages:totals.rows[0].messages,guests:totals.rows[0].guests,rooms:rooms.rows[0].rooms,activity:activity.rows});
});

io.use((socket,next)=>{
  const raw=socket.handshake.headers.cookie||"";
  const match=raw.match(/(?:^|;\s*)guest_session=([^;]+)/);
  if(!match) return next(new Error("Guest session missing. Refresh the page."));
  const parts=decodeURIComponent(match[1]).split(".");
  if(parts.length!==2 || !/^[a-f0-9]{24,40}$/.test(parts[0]) || !safeEqual(parts[1],sign(parts[0])))
    return next(new Error("Guest session invalid. Refresh the page."));
  socket.data.guestId=parts[0];
  next();
});
const roomCounts=new Map();
io.on("connection",socket=>{
  const guestId=socket.data.guestId;
  socket.data.room=null;
  socket.on("room:join",async (payload,ack=()=>{})=>{
    try {
      const slug=roomSlug(payload?.room);
      const found=await pool.query("SELECT slug,title FROM chat_rooms WHERE slug=$1",[slug]);
      if(!found.rowCount) return ack({ok:false,error:"Room not found."});
      if(socket.data.room) {
        socket.leave(socket.data.room);
        roomCounts.set(socket.data.room,Math.max(0,(roomCounts.get(socket.data.room)||1)-1));
      }
      socket.join(slug); socket.data.room=slug;
      roomCounts.set(slug,(roomCounts.get(slug)||0)+1);
      io.to(slug).emit("presence:update",{room:slug,online:roomCounts.get(slug)});
      ack({ok:true,room:found.rows[0]});
    } catch(e){console.error(e);ack({ok:false,error:"Could not join room."});}
  });
  socket.on("message:send",async(payload,ack=()=>{})=>{
    const room=socket.data.room;
    const body=cleanText(payload?.body,1000);
    if(!room) return ack({ok:false,error:"Join a room first."});
    if(!body) return ack({ok:false,error:"Write a message first."});
    if(body.length>1000) return ack({ok:false,error:"Message is too long."});
    try {
      const displayName=`Guest-${guestId.slice(-5)}`;
      const {rows}=await pool.query(
        `INSERT INTO chat_messages(room_slug,guest_id,display_name,body)
         VALUES($1,$2,$3,$4)
         RETURNING id,guest_id AS "guestId",display_name AS "displayName",body,created_at AS "createdAt"`,
        [room,guestId,displayName,body]);
      io.to(room).emit("message:new",rows[0]);
      ack({ok:true});
    } catch(e){console.error(e);ack({ok:false,error:"Message could not be saved."});}
  });
  socket.on("disconnect",()=>{
    const room=socket.data.room;
    if(room){roomCounts.set(room,Math.max(0,(roomCounts.get(room)||1)-1));io.to(room).emit("presence:update",{room,online:roomCounts.get(room)});}
  });
});

async function main(){
  await initDb();
  server.listen(PORT,"0.0.0.0",()=>console.log(`Nexconn custom chat listening on ${PORT}`));
}
main().catch(e=>{console.error("Startup failed:",e);process.exit(1);});
