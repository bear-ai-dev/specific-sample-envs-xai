#!/usr/bin/env node
const { join } = require("node:path");
const { runWithBun } = require("./run-with-bun.cjs");

runWithBun([join(__dirname, "../dist/index.js"), ...process.argv.slice(2)]);
