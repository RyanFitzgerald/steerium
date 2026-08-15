/**
 * Side-effect module: hide Node's "SQLite is an experimental feature" warning.
 * steerium targets Node >= 22.13 where node:sqlite is available without a
 * flag; the warning is noise, not actionable. Imported first by the CLI.
 */
const original = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === "string" ? warning : warning?.message;
  if (message?.includes("SQLite is an experimental feature")) return;
  return (original as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
