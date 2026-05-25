import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const commands = new Map();
const observers = [];

export async function loadCommands() {
  const commandPath = path.join(__dirname, "../commands");
  const observerPath = path.join(__dirname, "../observers");
  
  // Load commands recursively
  const loadDir = async (dir) => {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      
      if (stat.isDirectory()) {
        await loadDir(filePath);
      } else if (file.endsWith(".js")) {
        try {
          const fileURL = pathToFileURL(filePath).href;
          const command = await import(fileURL);
          if (command.name) {
            if (commands.has(command.name)) {
              console.log(`⚠️ Duplicate command skipped: ${command.name}`);
            } else {
              commands.set(command.name, command);
              console.log(`✅ Loaded: ${command.name} [${command.category || "General"}]`);
            }
          }
        } catch (err) {
            console.log(`❌ FAILED ${file}: ${err.message}`);
        }
      }
    }
  };
  
  if (fs.existsSync(commandPath)) await loadDir(commandPath);
  
  // Load observers
  if (fs.existsSync(observerPath)) {
    const files = fs.readdirSync(observerPath).filter(f => f.endsWith(".js"));
    for (const file of files) {
      try {
        const fileURL = pathToFileURL(path.join(observerPath, file)).href;
        const observer = await import(fileURL);
        if (observer.execute) observers.push(observer);
        console.log(`👀 Observer loaded: ${file}`);
      } catch (err) {
        console.log(`❌ Observer FAILED ${file}: ${err.message}`);
      }
    }
  }
  
  return commands;
}

export async function handleMessage(sock, msg, commands, prefix, owner) {
  const body = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
  if (!body.startsWith(prefix)) {
    for (const obs of observers) {
      try { await obs.execute(sock, msg); } catch (e) {}
    }
    return;
  }
  
  const args = body.slice(prefix.length).trim().split(/ +/);
  const commandName = args.shift().toLowerCase();
  
  if (!commands.has(commandName)) return;
  
  const command = commands.get(commandName);
  const from = msg.key.remoteJid;
  const isGroup = from.endsWith("@g.us");
  
  let isAdmin = false;
  let isBotAdmin = false;
  let groupMetadata = null;
  
  if (isGroup) {
    groupMetadata = await sock.groupMetadata(from);
    const sender = msg.key.participant;
    isAdmin = groupMetadata.participants.find(p => p.id === sender)?.admin !== null;
    isBotAdmin = groupMetadata.participants.find(p => p.id === sock.user.id)?.admin !== null;
  }
  
  try {
    await command.execute(sock, msg, args, { isAdmin, isBotAdmin, groupMetadata, prefix, owner });
  } catch (err) {
    console.log(`❌ Command error in ${commandName}:`, err);
    await sock.sendMessage(from, { text: "Command failed. Check logs." });
  }
}

export function getAllCommands() {
  return Array.from(commands.values());
}
