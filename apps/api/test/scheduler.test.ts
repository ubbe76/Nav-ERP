import { describe, expect, it, vi } from "vitest";
import { startScheduler } from "../src/scheduler.js";

describe("scheduler", () => {
  it("runs every job per tick and survives a throwing job", async () => {
    const ran: string[] = [];
    const errors: string[] = [];
    const s = startScheduler(
      [
        {
          name: "bad",
          run: async () => {
            throw new Error("boom");
          },
        },
        {
          name: "good",
          run: async () => {
            ran.push("good");
          },
        },
      ],
      { intervalMs: 60_000, firstDelayMs: 60_000, log: (msg) => errors.push(msg) }
    );
    try {
      await s.tick();
      await s.tick();
      expect(ran).toEqual(["good", "good"]);
      expect(errors).toHaveLength(2);
    } finally {
      await s.stop();
    }
  });

  it("never overlaps a tick that is still running", async () => {
    let release!: () => void;
    let runs = 0;
    const s = startScheduler(
      [
        {
          name: "slow",
          run: () => {
            runs++;
            return new Promise<void>((r) => (release = r));
          },
        },
      ],
      { intervalMs: 60_000, firstDelayMs: 60_000 }
    );
    try {
      const first = s.tick();
      await s.tick(); // returns at once — the first is still running
      expect(runs).toBe(1);
      release();
      await first;
    } finally {
      await s.stop();
    }
  });

  it("stop() clears the timers", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(async () => {});
      const s = startScheduler([{ name: "j", run }], { intervalMs: 1000, firstDelayMs: 500 });
      await s.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ticks first after firstDelayMs, then every intervalMs", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(async () => {});
      const s = startScheduler([{ name: "j", run }], { intervalMs: 1000, firstDelayMs: 500 });
      await vi.advanceTimersByTimeAsync(499);
      expect(run).toHaveBeenCalledTimes(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(run).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2000);
      expect(run).toHaveBeenCalledTimes(4);
      await s.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() waits for a tick that is still running", async () => {
    let release!: () => void;
    let finished = false;
    const s = startScheduler(
      [{ name: "slow", run: () => new Promise<void>((r) => (release = r)).then(() => void (finished = true)) }],
      { intervalMs: 60_000, firstDelayMs: 60_000 }
    );
    const running = s.tick();
    let stopped = false;
    const stopping = s.stop().then(() => void (stopped = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(finished).toBe(true);
    await running;
  });
});
