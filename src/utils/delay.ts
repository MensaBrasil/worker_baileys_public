/**
 * Pause for a random duration with jitter. Never goes below `minSeconds`.
 * Can land below or above `maxSeconds` depending on jitter.
 * Press 's' to skip while waiting (if running in a TTY).
 *
 * @param minSeconds Minimum delay in seconds (inclusive, >= 0)
 * @param maxSeconds Maximum delay in seconds (>= minSeconds)
 * @param jitterSeconds Optional jitter range in seconds (>= 0). Applied as [-jitter, +jitter].
 */
export async function delaySecs(minSeconds: number, maxSeconds: number, jitterSeconds: number = 0): Promise<void> {
  if (!Number.isFinite(minSeconds) || !Number.isFinite(maxSeconds) || !Number.isFinite(jitterSeconds)) {
    throw new Error("minSeconds, maxSeconds, and jitterSeconds must be finite numbers.");
  }
  if (minSeconds < 0 || maxSeconds < 0 || jitterSeconds < 0) {
    throw new Error("minSeconds, maxSeconds, and jitterSeconds must be >= 0.");
  }
  if (maxSeconds < minSeconds) {
    throw new Error("maxSeconds must be >= minSeconds.");
  }

  const rand = (lo: number, hi: number) => Math.random() * (hi - lo) + lo;
  const base = rand(minSeconds, maxSeconds);
  const jitter = jitterSeconds > 0 ? rand(-jitterSeconds, jitterSeconds) : 0;

  const chosenSeconds = Math.max(minSeconds, base + jitter);
  const totalMs = Math.max(0, Math.round(chosenSeconds * 1000));
  const deadline = Date.now() + totalMs;

  let skipped = false;
  let aborted = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = () => {
    const remainingMs = Math.max(0, deadline - Date.now());
    const remainingSec = Math.ceil(remainingMs / 1000);
    process.stdout.write(`\rRemaining seconds: ${remainingSec}  (press 's' to skip) `);
  };

  tick();
  const interval = setInterval(tick, 1000);

  let _resolveSleep!: () => void;
  const sleep = new Promise<void>((res) => {
    _resolveSleep = res;
    timer = setTimeout(res, totalMs);
  });

  let cleanupKeypress = () => {};
  const keypress = new Promise<void>((res) => {
    if (!process.stdin.isTTY) {
      return;
    }

    const onData = (buf: Buffer) => {
      const ch = buf.toString("utf8");
      if (ch === "s" || ch === "S") {
        skipped = true;
        res();
      } else if (buf.length && buf[0] === 3) {
        aborted = true;
        res();
      }
    };

    const cleanup = () => {
      process.stdin.off("data", onData);
      try {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
      } catch {
        // Ignore
      }
      process.stdin.pause();
    };

    cleanupKeypress = cleanup;

    try {
      process.stdin.resume();
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.on("data", onData);
    } catch {
      cleanup();
    }
  });

  await Promise.race([sleep, keypress]);
  cleanupKeypress();
  clearInterval(interval);
  if (timer) clearTimeout(timer);

  if (aborted) {
    process.stdout.write("\rInterrompido (Ctrl+C).          \n");
    process.exit(130);
  }

  if (skipped) {
    process.stdout.write("\rDelay skipped                     \n");
  } else {
    process.stdout.write("\rDelay finished                    \n");
  }
}
