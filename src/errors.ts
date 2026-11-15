export class SourceConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceConfigurationError";
  }
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** The source repository could not be read (missing local path, failed Git fetch/checkout). Never carries credentials. */
export class SourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceUnavailableError";
  }
}

/** A single artifact's base-store write or post-write verification failed mid-run. */
export class InstallFailedError extends Error {
  constructor(
    public readonly artifactId: string,
    public readonly code: "install-failed" | "verification-failed" | "source-configuration",
    message: string
  ) {
    super(message);
    this.name = "InstallFailedError";
  }
}
