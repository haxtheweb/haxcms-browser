/**
 * Boot check: start the built Worker (dist/haxcms-worker.js) the way the
 * host page does, without a browser, and fail if haxcms-nodejs cannot start
 * in it or cannot answer a request.
 *
 *   node scripts/boot-check.mjs [distFolder]
 *
 * Runs in Node's own worker threads, so it works on build hosts that have no
 * Chrome (Vercel). build-hosted.mjs runs it before the site is assembled: a
 * haxcms-nodejs change that stops the runtime from starting then fails the
 * build, and the host keeps serving the last deployment that worked, instead
 * of shipping "HAXcms could not start". The full checks (parity, the demo
 * end to end, WebKit and Firefox) stay in `npm test` and CI.
 */
import console from "node:console";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.resolve(process.argv[2] || path.join(root, "dist"));
const workerFile = path.join(dist, "haxcms-worker.js");
const snapshotFile = path.join(dist, "haxcms-snapshot.json");
// a cold start on a busy build host can be slow; a broken one fails fast
const TIMEOUT_MS = 120000;

// The bundle expects a Worker global scope: postMessage, onmessage and self.
// This prelude makes a Node worker thread look like one, then loads the
// bundle as a script in that scope.
const PRELUDE = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const vm = require("node:vm");
globalThis.self = globalThis;
globalThis.postMessage = (data) => parentPort.postMessage(data);
const events = new EventTarget();
globalThis.addEventListener = events.addEventListener.bind(events);
globalThis.removeEventListener = events.removeEventListener.bind(events);
globalThis.dispatchEvent = events.dispatchEvent.bind(events);
parentPort.on("message", (data) => {
  if (typeof globalThis.onmessage === "function") {
    globalThis.onmessage({ data });
  }
  events.dispatchEvent(new MessageEvent("message", { data }));
});
const source = fs.readFileSync(workerData.workerFile, "utf8");
// A browser Worker has none of Node's globals. The bundle checks for some of
// them (require, process, Buffer) and would use Node's instead of its own
// shims, so hide them: the check must see the runtime the browser sees.
// fetch and its classes load lazily and need Node's globals, so load them
// first.
void [globalThis.fetch, globalThis.Request, globalThis.Response, globalThis.Headers, globalThis.FormData, globalThis.WebSocket];
for (const name of [
  "require",
  "module",
  "exports",
  "__filename",
  "__dirname",
  "global",
  "Buffer",
  "process",
  "setImmediate",
  "clearImmediate",
]) {
  try {
    delete globalThis[name];
  } catch {
    // not configurable: leave it
  }
  if (name in globalThis) {
    globalThis[name] = undefined;
  }
}
vm.runInThisContext(source, { filename: workerData.workerFile });
`;

// an error in the bundle quotes its (minified, very long) source line
function readable(error) {
  return String((error && error.stack) || error)
    .split("\n")
    .filter((line) => line.length < 400)
    .join("\n");
}

let worker = null;
let timer = null;

async function check() {
  for (const file of [workerFile, snapshotFile]) {
    if (!fs.existsSync(file)) {
      throw new Error(file + " is missing; run the build first");
    }
  }
  worker = new Worker(PRELUDE, { eval: true, workerData: { workerFile } });
  const pending = new Map();
  let next = 0;
  // settles (rejects) when the Worker breaks, stops or takes too long; every
  // request races it, so a Worker that never answers still fails the check
  const stopped = new Promise((resolve, reject) => {
    worker.on("error", reject);
    worker.on("exit", (code) => {
      reject(
        new Error(
          "the Worker stopped (exit code " + code + ") before answering",
        ),
      );
    });
    timer = setTimeout(
      () => reject(new Error("no answer within " + TIMEOUT_MS / 1000 + "s")),
      TIMEOUT_MS,
    );
  });
  stopped.catch(() => {});
  worker.on("message", (data) => {
    const waiting = pending.get(data && data.id);
    if (!waiting) {
      return;
    }
    pending.delete(data.id);
    if (data.ok) {
      waiting.resolve(data.result);
    } else {
      waiting.reject(new Error(data.error));
    }
  });
  function send(type, args) {
    const answer = new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      worker.postMessage(Object.assign({ id, type }, args || {}));
    });
    return Promise.race([answer, stopped]);
  }

  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
  const booted = await send("boot", { snapshot, root: "/haxcms" });
  if (!booted || !booted.mode) {
    throw new Error(
      "boot answered without a server mode: " + JSON.stringify(booted),
    );
  }
  const signedIn = await send("signIn", {});
  if (!signedIn || signedIn.status !== 200) {
    throw new Error(
      "signing in the local user answered " + (signedIn && signedIn.status),
    );
  }
  return booted;
}

try {
  const booted = await check();
  console.log(
    "Boot check passed: haxcms-nodejs started in the Worker (" +
      booted.mode +
      ", " +
      booted.bootMs +
      " ms) and signed in the local user.",
  );
} catch (error) {
  console.error("Boot check FAILED: " + readable(error));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  if (worker) {
    worker.removeAllListeners("exit");
    await worker.terminate();
  }
}
