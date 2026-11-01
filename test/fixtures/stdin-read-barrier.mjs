// Synchronize the producer with the real synchronous read, without replacing
// its behavior or changing stdin flags. The CLI still owns fd 0.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const readFileSync = fs.readFileSync;
fs.readFileSync = function (path, ...args) {
  if (path === 0) process.send?.("stdin-read");
  return readFileSync.call(this, path, ...args);
};
syncBuiltinESMExports();
