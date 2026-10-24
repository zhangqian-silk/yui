#!/usr/bin/env node
import { runConnectionConfigCli } from "./connectionConfigCli.js";

process.exitCode = runConnectionConfigCli(process.argv.slice(2));
