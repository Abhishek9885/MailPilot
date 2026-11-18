export class ApiError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly retryAfterSeconds: number | undefined = undefined
  ) {
    super(message);
    this.name = "ApiError";
  }
}
