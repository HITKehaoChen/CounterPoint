import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * If the command looks like a file path (contains a separator), resolve it
 * against the current working directory so relative script paths work even
 * when the child process cwd is an isolated workspace. Bare names stay on
 * PATH resolution.
 */
export function resolveExecutable(command: string): string {
  return command.includes('/') || command.includes('\\') ? resolve(command) : command;
}

/**
 * Resolve argument values that look like relative file paths against the
 * current working directory when the file actually exists there. Other
 * arguments (flags, placeholders, absolute paths) are left untouched.
 */
export function resolveArgument(arg: string): string {
  if (!arg.includes('/') && !arg.includes('\\')) return arg;
  if (arg.startsWith('{')) return arg;
  const absolute = resolve(arg);
  return existsSync(absolute) ? absolute : arg;
}
