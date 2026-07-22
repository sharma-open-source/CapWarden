/**
 * Build NODE_OPTIONS strings that survive Node's own parsing rules.
 *
 * Node splits NODE_OPTIONS on unquoted spaces, so a register path like
 * `/Users/x/My Project/node_modules/capwarden/dist/register.js` must be
 * double-quoted or the child process tries to preload `/Users/x/My` and
 * crashes with MODULE_NOT_FOUND. Literal `"` in the path is escaped as `\"`,
 * which Node's parser honors inside a quoted value.
 */
export function appendRequireFlag(priorNodeOptions: string, registerPath: string): string {
  const quoted = `"${registerPath.replace(/"/g, '\\"')}"`;
  return `${priorNodeOptions} --require ${quoted}`.trim();
}
