export { parseArgs, DEFAULT_PATH, type ParsedArgs } from "./args.js";
export { runCli, defaultContext, EXIT_USAGE, type CliContext } from "./run.js";
export { runProxy, needsShell, quoteForCmd, type ProxyStreams } from "./proxy.js";
export { LineSplitter } from "./line-splitter.js";
export { LineTap } from "./line-tap.js";
export {
  Journal,
  journalPath,
  computeEntryHash,
  type JournalEntry,
  type EntryInput,
} from "./journal.js";
export { CallRecorder, type RecorderOptions } from "./recorder.js";
export { canonicalJson, sha256, hashValue, GENESIS_HASH } from "./canonical-json.js";
export {
  redact,
  redactString,
  isSensitiveKey,
  isLuhnValid,
  defaultConfig,
  defaultPatterns,
  REDACTED,
  DEFAULT_MAX_STRING_LENGTH,
  DEFAULT_SENSITIVE_KEYS,
  type RedactionConfig,
  type RedactionPattern,
} from "./redact.js";
export {
  loadConfig,
  findConfigFile,
  CONFIG_FILENAME,
  type FileConfig,
  type LoadedConfig,
  type RedactionFileConfig,
} from "./config.js";
export { HELP_TEXT } from "./help.js";
export { readVersion } from "./version.js";
