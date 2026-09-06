export class RetryableJobError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RetryableJobError";
  }
}

export class PermanentJobError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PermanentJobError";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 1_000);
  }

  return "Unknown error";
}
