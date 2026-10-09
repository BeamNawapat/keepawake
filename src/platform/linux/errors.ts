/** Raised when a Linux helper is missing, so callers can print one clear line instead of a stack. */
export class UnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedError";
  }
}
