#!/usr/bin/env node
/**
 * Dev: Next on :3000 + Electron window. Data under .desktop-data/
 */
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const userData = path.join(root, ".desktop-data");
const keyPath = path.join(userData, "master.key");

fs.mkdirSync(userData, { recursive: true });
let masterKey = "";
if (fs.existsSync(keyPath)) {
  masterKey = fs.readFileSync(keyPath, "utf8").trim();
}
if (masterKey.length < 16) {
  masterKey = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(keyPath, masterKey, { encoding: "utf8", mode: 0o600 });
}

const env = {
  ...process.env,
  CMAE_USER_DATA: userData,
  CMAE_MASTER_KEY: masterKey,
  CMAE_DEV_URL: "http://127.0.0.1:3000",
};

const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const electronBin = path.join(
  root,
  "node_modules",
  "electron",
  "cli.js",
);

const nextProc = spawn(process.execPath, [nextBin, "dev", "-H", "127.0.0.1", "-p", "3000"], {
  cwd: root,
  env,
  stdio: "inherit",
});

function waitForUrl(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() > deadline) {
          reject(new Error("Next dev server did not start"));
          return;
        }
        setTimeout(tick, 400);
      });
    };
    tick();
  });
}

/** @type {import('child_process').ChildProcess | null} */
let electronProc = null;

waitForUrl("http://127.0.0.1:3000/")
  .then(() => {
    electronProc = spawn(
      process.execPath,
      [electronBin, path.join(root, "desktop", "main.cjs")],
      {
        cwd: root,
        env: {
          ...env,
          ELECTRON_RUN_AS_NODE: undefined,
        },
        stdio: "inherit",
      },
    );
    electronProc.on("exit", (code) => {
      nextProc.kill("SIGTERM");
      process.exit(code ?? 0);
    });
  })
  .catch((err) => {
    console.error(err);
    nextProc.kill("SIGTERM");
    process.exit(1);
  });

function shutdown() {
  electronProc?.kill("SIGTERM");
  nextProc.kill("SIGTERM");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
