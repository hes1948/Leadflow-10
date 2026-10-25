type Waiter = {
  grant: () => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
};

function setting(name: string, fallback: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name}_invalid`);
  }
  return value;
}

// Per-process pressure control; independent of company/customer identifiers.
const concurrency = setting("LEADFLOW_INTAKE_CONCURRENCY", 16, 256);
const maxWaiters = setting("LEADFLOW_INTAKE_MAX_WAITERS", 20000, 100000);
const waitMs = setting("LEADFLOW_INTAKE_WAIT_MS", 45000, 120000);
let active = 0;
const queue: Waiter[] = [];

function detach(waiter: Waiter) {
  if (waiter.timer) clearTimeout(waiter.timer);
  if (waiter.signal && waiter.onAbort) {
    waiter.signal.removeEventListener("abort", waiter.onAbort);
  }
}

function releasePermit() {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active--;
    while (queue.length && active < concurrency) {
      const waiter = queue.shift()!;
      detach(waiter);
      if (waiter.signal?.aborted) {
        waiter.reject(new Error("intake_request_aborted"));
        continue;
      }
      active++;
      waiter.grant();
    }
  };
}

export async function acquireIntakePermit(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw new Error("intake_request_aborted");
  if (active < concurrency && !queue.length) {
    active++;
    return releasePermit();
  }
  if (queue.length >= maxWaiters) throw new Error("intake_busy");
  return new Promise<() => void>((resolve, reject) => {
    const waiter: Waiter = {
      grant: () => resolve(releasePermit()),
      reject,
      signal,
    };
    function cancel(message: string) {
      const index = queue.indexOf(waiter);
      if (index < 0) return;
      queue.splice(index, 1);
      detach(waiter);
      reject(new Error(message));
    }
    queue.push(waiter);
    waiter.onAbort = () => cancel("intake_request_aborted");
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    waiter.timer = setTimeout(() => cancel("intake_busy"), waitMs);
    if (signal?.aborted) cancel("intake_request_aborted");
  });
}
