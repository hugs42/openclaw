export type MarkerMatchMode = "none" | "exact" | "normalized" | "first_line";

export interface MarkerMatchResult {
  hasMarker: boolean;
  mode: MarkerMatchMode;
}

const MIN_FIRST_LINE_CHARS = 10;

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
}

export function matchMarkerInScrapedText(scrapedText: string, marker: string): MarkerMatchResult {
  if (marker.length === 0) {
    return { hasMarker: true, mode: "exact" };
  }

  if (scrapedText.includes(marker)) {
    return { hasMarker: true, mode: "exact" };
  }

  const normalizedMarker = normalizeText(marker);
  const normalizedScraped = normalizeText(scrapedText);
  if (normalizedMarker.length > 0 && normalizedScraped.includes(normalizedMarker)) {
    return { hasMarker: true, mode: "normalized" };
  }

  const firstLine = marker.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const normalizedFirstLine = normalizeText(firstLine);
  if (normalizedFirstLine.length >= MIN_FIRST_LINE_CHARS && normalizedScraped.includes(normalizedFirstLine)) {
    return { hasMarker: true, mode: "first_line" };
  }

  return { hasMarker: false, mode: "none" };
}
