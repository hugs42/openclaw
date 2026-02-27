import { describe, expect, it } from "vitest";
import { matchMarkerInScrapedText } from "../src/ui/markerMatch.js";

describe("matchMarkerInScrapedText", () => {
  it("matches exact marker text", () => {
    const result = matchMarkerInScrapedText("foo [[RID]] bar", "[[RID]]");
    expect(result).toEqual({ hasMarker: true, mode: "exact" });
  });

  it("matches after whitespace normalization", () => {
    const marker = "Line one\nLine two";
    const scraped = "prefix Line one   Line two suffix";
    const result = matchMarkerInScrapedText(scraped, marker);
    expect(result).toEqual({ hasMarker: true, mode: "normalized" });
  });

  it("falls back to first line match for long prompts", () => {
    const marker = "This is a long first line\nwith second line missing";
    const scraped = "The AX text only contains This is a long first line right now";
    const result = matchMarkerInScrapedText(scraped, marker);
    expect(result).toEqual({ hasMarker: true, mode: "first_line" });
  });

  it("returns none when no strategy matches", () => {
    const result = matchMarkerInScrapedText("foo bar", "unrelated marker");
    expect(result).toEqual({ hasMarker: false, mode: "none" });
  });

  it("treats empty marker as matched", () => {
    const result = matchMarkerInScrapedText("anything", "");
    expect(result).toEqual({ hasMarker: true, mode: "exact" });
  });
});
