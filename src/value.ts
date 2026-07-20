export function firstLine(text: string | undefined): string | undefined {
  return text?.split(/\r\n|\n|\r/, 1)[0];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
