/** Provider credentials owned by Peers and never intentionally exposed to a model. */
export const CREDENTIAL_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

/** Capture configured credential values once per execution, longest first. */
export function registeredCredentialValues(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [...new Set(
    CREDENTIAL_ENV_NAMES.map((name) => env[name]).filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  )].sort((a, b) => b.length - a.length);
}

/** Exact-value redaction avoids putting credentials in prompts, tool results, or logs. */
export function redactRegisteredCredentials(text: string, credentials: readonly string[]): string {
  let redacted = text;
  for (const credential of credentials) {
    redacted = redacted.split(credential).join("[REDACTED CREDENTIAL]");
  }
  return redacted;
}
