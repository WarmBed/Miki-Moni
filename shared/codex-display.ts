export function stripCodexBrowserContext(text: string): string {
  const trimmed = text.trim();
  if (!/^#?\s*In app browser:/i.test(trimmed)) return text;

  const marker = "My request for Codex:";
  const markerAt = trimmed.indexOf(marker);
  if (markerAt < 0) return text;

  const request = trimmed.slice(markerAt + marker.length).trim();
  return request || text;
}
