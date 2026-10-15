// In-process scheduler (frakt etapp 2). Started from server.ts ONLY — never
// from buildApp, so the test suites (which build the app without listening)
// never run jobs. Each job guards itself against running twice across
// processes (the tracking job's lease); this module only ticks.
export interface SchedulerJob {
  name: string;
  run: () => Promise<unknown>;
}

export function startScheduler(
  jobs: SchedulerJob[],
  opts: { intervalMs?: number; firstDelayMs?: number; log?: (msg: string, extra?: unknown) => void } = {}
) {
  const intervalMs = opts.intervalMs ?? 5 * 60_000;
  const log = opts.log ?? ((msg: string, extra?: unknown) => console.error(msg, extra));
  let current: Promise<void> | null = null;
  let stopped = false;

  async function runAll() {
    for (const job of jobs) {
      try {
        await job.run();
      } catch (err) {
        log(`Scheduled job ${job.name} failed`, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // One tick at a time; a tick that is still running makes the next a no-op.
  async function tick() {
    if (current || stopped) return;
    current = runAll();
    try {
      await current;
    } finally {
      current = null;
    }
  }

  let interval: NodeJS.Timeout | null = null;
  const first = setTimeout(() => {
    void tick();
    interval = setInterval(() => void tick(), intervalMs);
    interval.unref();
  }, opts.firstDelayMs ?? 60_000);
  first.unref();

  return {
    tick,
    // Clears the timers and waits for a running tick, so the server closes
    // its database pool only after the job let go of it.
    async stop() {
      stopped = true;
      clearTimeout(first);
      if (interval) clearInterval(interval);
      await current;
    },
  };
}
