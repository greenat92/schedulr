function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function sendBookingConfirmation(toEmail: string, host: string, startAt: string): void {
  if (!toEmail) {
    throw new Error("email required");
  }

  const latencyMs = parseInt(process.env.EMAIL_LATENCY_MS ?? "300", 10);
  const failureRate = parseFloat(process.env.EMAIL_FAILURE_RATE ?? "0.05");

  sleepSync(latencyMs);

  if (Math.random() < failureRate) {
    throw new Error("email service unavailable");
  }
}
