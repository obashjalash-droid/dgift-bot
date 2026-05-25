import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import makeWASocket, { 
  useMultiFileAuthState, 
  DisconnectReason, 
  fetchLatestBaileysVersion 
} from "@whiskeysockets/baileys";
import { createClient } from "@supabase/supabase-js";
import AdmZip from "adm-zip";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadCommands, handleMessage } from "./lib/router.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 10000;
const OWNER_NUMBER = process.env.OWNER_NUMBER || "254748548334";
const PREFIX = process.env.PREFIX || ".";
const BOT_NAME = process.env.BOT_NAME || "dgift";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(express.static("public"));
app.get("/", (req, res) => res.json({ status: "alive", bot: BOT_NAME }));

let lastSave = 0;
const SAVE_INTERVAL = 120000; // 2 minutes

async function saveSessionToSupabase() {
  if (Date.now() - lastSave < SAVE_INTERVAL) return;
  if (!fs.existsSync("./session")) return;
  
  try {
    const zip = new AdmZip();
    zip.addLocalFolder("./session");
    const zipBuffer = zip.toBuffer().toString("base64");
    
    await supabase.from("bu_sessions").upsert({ 
      id: "dgift-session", 
      data: zipBuffer 
    });
    lastSave = Date.now();
    console.log("✅ Session saved to Supabase");
  } catch (err) {
    console.log("Session save error:", err.message);
  }
}

async function loadSessionFromSupabase() {
  try {
    const { data } = await supabase.from("bu_sessions").select("data").eq("id", "dgift-session").single();
    if (!data) return;
    
    if (!fs.existsSync("./session")) fs.mkdirSync("./session");
    const zip = new AdmZip(Buffer.from(data.data, "base64"));
    zip.extractAllTo("./session", true);
    console.log("✅ Session loaded from Supabase");
  } catch (err) {
    console.log("No session found in Supabase");
  }
}

async function startBot() {
  await loadSessionFromSupabase();
  const { state, saveCreds } = await useMultiFileAuthState("./session");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    syncFullHistory: false,
    fireInitQueries: false,
    browser: [BOT_NAME, "Chrome", "1.0.0"]
  });

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    await saveSessionToSupabase();
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) io.emit("qr", qr);
    
    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      
      if (lastDisconnect?.error?.message?.includes("conflict")) {
        console.log("❌ Conflict detected. Stopping to kill duplicate session.");
        process.exit(0);
      }
      
      if (shouldReconnect) startBot();
    }
    
    if (connection === "open") {
      console.log("✅ Bot connected!");
      io.emit("connected");
      await sock.sendMessage(OWNER_NUMBER + "@s.whatsapp.net", { 
        text: `🎉 ${BOT_NAME} is now online!\nPrefix: ${PREFIX}\nTry: ${PREFIX}menu` 
      });
    }
  });

  const commands = await loadCommands();
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;
    await handleMessage(sock, msg, commands, PREFIX, OWNER_NUMBER);
  });
}

io.on("connection", (socket) => {
  socket.on("pair", async (number) => {
    const { state } = await useMultiFileAuthState("./session");
    const tempSock = makeWASocket({ auth: state, printQRInTerminal: false });
    const code = await tempSock.requestPairingCode(number.replace(/[^0-9]/g, ""));
    socket.emit("pair-code", code);
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
startBot();
