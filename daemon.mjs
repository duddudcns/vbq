#!/usr/bin/env node
// vbq daemon — wraps vbnet-ls --stdio for one solution root.
// Listens on a named pipe and answers JSON requests from vbq CLI.
// Auto-shuts down after IDLE_MS without requests.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createWriteStream, writeFileSync, unlinkSync, existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import {
  rootHash, pipeName, stateFile, readyFile, logFile, writeState, removeState
} from "./lib/registry.mjs";
import { makeFramer, frame } from "./lib/lsp-frame.mjs";

const IDLE_MS = 30 * 60 * 1000; // 30 min
const INIT_TIMEOUT_MS = 180 * 1000;

const root = process.argv[2];
if (!root) { console.error("daemon: root required"); process.exit(2); }

const hash = rootHash(root);
const pipe = pipeName(hash);
const log = createWriteStream(logFile(hash), { flags: "a" });
const tlog = (msg) => log.write(`[${new Date().toISOString()}] ${msg}\n`);

tlog(`START root=${root} pid=${process.pid} pipe=${pipe}`);

// Cleanup old state for this hash
removeState(hash);
writeState(hash, {
  root, hash, pid: process.pid, pipe,
  started: new Date().toISOString(),
  lastActivity: new Date().toISOString(),
  ready: false,
});

let ready = false;
let lastActivity = Date.now();
let nextId = 1;
const pending = new Map(); // id -> {resolve, reject, method}

// ---- spawn vbnet-ls ----
const child = spawn("vbnet-ls", ["--stdio"], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: root,
  windowsHide: true,
});
tlog(`vbnet-ls spawned pid=${child.pid}`);

child.stderr.on("data", (chunk) => {
  const s = chunk.toString();
  log.write(s);
  // Detect successful solution load
  if (!ready && /Solution loaded:\s*\d+\s+VB\.NET\s+project/i.test(s)) {
    markReady("stderr: Solution loaded");
  }
});

const parseLsp = makeFramer((msg) => {
  if (msg.id !== undefined && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(msg.error);
    else p.resolve(msg.result);
  }
  // Notifications: log and ignore
});
child.stdout.on("data", parseLsp);

child.on("exit", (code, sig) => {
  tlog(`vbnet-ls exited code=${code} sig=${sig}`);
  shutdown(1);
});

function sendLsp(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    child.stdin.write(frame({ jsonrpc: "2.0", id, method, params }));
  });
}
function notifyLsp(method, params) {
  child.stdin.write(frame({ jsonrpc: "2.0", method, params }));
}

// ---- LSP initialize ----
const rootUri = pathToFileURL(root).href;
const rootName = root.split(/[\\/]/).filter(Boolean).pop();

(async () => {
  try {
    await sendLsp("initialize", {
      processId: process.pid,
      clientInfo: { name: "vbq-daemon", version: "0.1" },
      workspaceFolders: [{ uri: rootUri, name: rootName }],
      rootPath: root,
      rootUri,
      capabilities: {
        workspace: {
          configuration: true,
          workspaceFolders: true,
          didChangeConfiguration: { dynamicRegistration: true },
          symbol: { dynamicRegistration: true },
        },
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: true },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true, dynamicRegistration: true },
          references: { dynamicRegistration: true },
          definition: { dynamicRegistration: true, linkSupport: true },
          hover: { contentFormat: ["plaintext", "markdown"], dynamicRegistration: true },
        },
        general: { positionEncodings: ["utf-16"] },
      },
      initializationOptions: {},
    });
    notifyLsp("initialized", {});
    tlog("LSP initialized; waiting for solution load");
    // Fallback: if stderr never fires the regex within INIT_TIMEOUT_MS, mark ready anyway
    setTimeout(() => { if (!ready) markReady("init timeout fallback"); }, INIT_TIMEOUT_MS);
  } catch (e) {
    tlog(`INIT ERR ${e?.message || e}`);
    shutdown(1);
  }
})();

function markReady(reason) {
  ready = true;
  writeState(hash, {
    root, hash, pid: process.pid, pipe,
    started: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    ready: true,
  });
  try { writeFileSync(readyFile(hash), reason || "ok", "utf8"); } catch {}
  tlog(`READY (${reason})`);
}

// ---- named pipe server ----
// Per-request JSON, newline-delimited
const server = createServer((sock) => {
  let buf = "";
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      handleRequest(line, sock);
    }
  });
  sock.on("error", (e) => tlog(`SOCK ERR ${e.message}`));
});
server.listen(pipe, () => tlog(`pipe listening: ${pipe}`));

async function handleRequest(line, sock) {
  let req;
  try { req = JSON.parse(line); } catch { sock.write(JSON.stringify({ error: "bad json" }) + "\n"); return; }
  lastActivity = Date.now();
  try {
    const out = await dispatch(req);
    sock.write(JSON.stringify({ ok: true, result: out }) + "\n");
  } catch (e) {
    sock.write(JSON.stringify({ ok: false, error: String(e?.message || e) }) + "\n");
  }
}

async function dispatch(req) {
  switch (req.op) {
    case "ping":
      return { ready, pid: process.pid, root };
    case "wait-ready":
      return waitReady(req.timeoutMs ?? 180000);
    case "sym":
      await waitReady();
      return sendLsp("workspace/symbol", { query: req.query || "" });
    case "doc-sym": {
      await waitReady();
      const uri = pathToFileURL(req.file).href;
      await openIfNeeded(req.file, uri);
      return sendLsp("textDocument/documentSymbol", { textDocument: { uri } });
    }
    case "refs": {
      await waitReady();
      const { file, line, col, includeDeclaration = true } = req;
      const uri = pathToFileURL(file).href;
      await openIfNeeded(file, uri);
      return sendLsp("textDocument/references", {
        textDocument: { uri },
        position: { line, character: col },
        context: { includeDeclaration },
      });
    }
    case "def": {
      await waitReady();
      const { file, line, col } = req;
      const uri = pathToFileURL(file).href;
      await openIfNeeded(file, uri);
      return sendLsp("textDocument/definition", {
        textDocument: { uri },
        position: { line, character: col },
      });
    }
    case "hover": {
      await waitReady();
      const { file, line, col } = req;
      const uri = pathToFileURL(file).href;
      await openIfNeeded(file, uri);
      return sendLsp("textDocument/hover", {
        textDocument: { uri },
        position: { line, character: col },
      });
    }
    case "shutdown":
      setImmediate(() => shutdown(0));
      return { ok: true };
    default:
      throw new Error(`unknown op: ${req.op}`);
  }
}

function waitReady(timeoutMs = 180000) {
  if (ready) return Promise.resolve({ ready: true });
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const i = setInterval(() => {
      if (ready) { clearInterval(i); resolve({ ready: true }); }
      else if (Date.now() - t0 > timeoutMs) {
        clearInterval(i); reject(new Error("daemon not ready (timeout)"));
      }
    }, 200);
  });
}

const openedFiles = new Set();
async function openIfNeeded(file, uri) {
  if (openedFiles.has(uri)) return;
  const { readFile } = await import("node:fs/promises");
  let text = "";
  try { text = await readFile(file, "utf8"); } catch { /* ignore — server may still handle */ }
  notifyLsp("textDocument/didOpen", {
    textDocument: { uri, languageId: "vb", version: 1, text }
  });
  openedFiles.add(uri);
}

// ---- idle timer ----
setInterval(() => {
  if (Date.now() - lastActivity > IDLE_MS) {
    tlog(`IDLE ${Math.round((Date.now()-lastActivity)/1000)}s, shutting down`);
    shutdown(0);
  }
}, 60 * 1000);

function shutdown(code) {
  try { server.close(); } catch {}
  try { child.stdin.write(frame({ jsonrpc: "2.0", id: nextId++, method: "shutdown", params: null })); } catch {}
  setTimeout(() => {
    try { child.stdin.write(frame({ jsonrpc: "2.0", method: "exit", params: null })); } catch {}
    try { child.kill(); } catch {}
    removeState(hash);
    tlog(`SHUTDOWN code=${code}`);
    log.end();
    process.exit(code);
  }, 300);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
