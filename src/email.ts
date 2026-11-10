export async function sendBookingConfirmation(
  toEmail: string,
  host: string,
  startAt: string,
): Promise<void> {
  if (!toEmail) {
    throw new Error("email required");
  }

  const parsedLatency = Number(process.env.EMAIL_LATENCY_MS ?? 300);
  const latencyMs = Number.isFinite(parsedLatency) ? Math.max(0, parsedLatency) : 300;

  const parsedFailureRate = Number(process.env.EMAIL_FAILURE_RATE ?? 0.05);
  const failureRate = Number.isFinite(parsedFailureRate)
    ? Math.min(Math.max(parsedFailureRate, 0), 1)
    : 0.05;

  // Yield to the event loop instead of blocking it. A slow email provider must
  // never stall other requests.
  await new Promise((resolve) => setTimeout(resolve, latencyMs));

  if (Math.random() < failureRate) {
    throw new Error("email service unavailable");
  }
}
