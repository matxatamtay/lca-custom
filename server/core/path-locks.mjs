import path from "node:path";

function lockKey(filePath) {
  const resolved = path.normalize(path.resolve(filePath));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function createPathLockManager() {
  const queues = new Map();

  async function acquire(filePath) {
    const key = lockKey(filePath);
    let entry = queues.get(key);
    if (!entry) {
      entry = { tail: Promise.resolve(), pending: 0 };
      queues.set(key, entry);
    }

    const previous = entry.tail;
    let releaseGate;
    const gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    entry.tail = previous.then(() => gate);
    entry.pending += 1;
    await previous;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.pending -= 1;
      releaseGate();
      if (entry.pending === 0 && queues.get(key) === entry) queues.delete(key);
    };
  }

  async function withPaths(paths, operation) {
    const ordered = [...new Map(
      (paths || [])
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => [lockKey(value), path.normalize(path.resolve(value))])
    ).entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, value]) => value);

    const releases = [];
    try {
      for (const filePath of ordered) releases.push(await acquire(filePath));
      return await operation(ordered);
    } finally {
      for (let i = releases.length - 1; i >= 0; i--) releases[i]();
    }
  }

  function pendingCount() {
    let total = 0;
    for (const entry of queues.values()) total += entry.pending;
    return total;
  }

  return { acquire, pendingCount, withPaths };
}
