/**
 * Makes an asynchronous pause for a specified number of seconds, with an optional jitter.
 * @param seconds Number of seconds to pause.
 * @param jitter Optional jitter in seconds.
 */
export async function delaySecs(seconds: number, jitter: number = 0): Promise<void> {
  const j = jitter > 0 ? Math.floor(Math.random() * (jitter * 1000)) : 0;
  const ms = seconds * 1000 + j;
  let remaining = Math.ceil(ms / 1000);

  const interval = setInterval(() => {
    if (remaining > 0) {
      process.stdout.write(`\rRemaining seconds: ${remaining} `);
      remaining--;
    }
  }, 1000);

  await new Promise((res) => setTimeout(res, ms));
  clearInterval(interval);
  process.stdout.write("\rDelay finished          \n");
}
