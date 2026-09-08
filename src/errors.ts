export class SourceConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceConfigurationError";
  }
}
