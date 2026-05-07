export function normalizePromptText(text: string | null | undefined): string {
  return String(text ?? "").replace(/\r\n?/g, "\n");
}

export function hasPromptText(text: string | null | undefined): text is string {
  return typeof text === "string" && text.trim().length > 0;
}

export function appendPromptSuffix(prompt: string, suffix?: string | null): string {
  const normalizedPrompt = normalizePromptText(prompt);
  const normalizedSuffix = normalizePromptText(suffix ?? "");
  if (!hasPromptText(normalizedSuffix)) {
    return normalizedPrompt;
  }
  if (normalizedPrompt.length === 0) {
    return normalizedSuffix;
  }
  return normalizedPrompt.endsWith("\n")
    ? `${normalizedPrompt}${normalizedSuffix}`
    : `${normalizedPrompt}\n${normalizedSuffix}`;
}
