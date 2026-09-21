import { readPathState } from "./file-state.mjs";
import { createPathLockManager } from "./path-locks.mjs";

export function createEditTransactionCore(options = {}) {
  const lockManager = options.lockManager || createPathLockManager();

  async function run(paths, operation) {
    return lockManager.withPaths(paths, async (orderedPaths) => {
      const states = await Promise.all(orderedPaths.map((filePath) => readPathState(filePath)));
      const preState = new Map(states.map((state) => [state.path, state]));
      return operation({ paths: orderedPaths, preState });
    });
  }

  return {
    lockManager,
    readPathState,
    run
  };
}
