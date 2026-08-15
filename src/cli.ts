import { runCli } from "./run.js";

// A CLI's output is routinely piped into `head`, `less` and friends. When the
// reader exits first the remaining writes fail with EPIPE, which Node surfaces
// as an unhandled 'error' event and a stack trace. That is normal termination,
// not a failure, so swallow it and leave anything else to crash as usual.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });
}

process.exitCode = await runCli(process.argv.slice(2));
