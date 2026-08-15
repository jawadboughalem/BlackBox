import { runCli } from "./run.js";

process.exitCode = runCli(process.argv.slice(2));
