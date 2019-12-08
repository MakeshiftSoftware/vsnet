import debug from 'debug';

/**
 * Returns a debugger with the provided module name appended
 * @param {String} name Name of the module
 */
export default function createDebugger(name) {
  return debug(`@vsnet/socket:${name}`);
}
