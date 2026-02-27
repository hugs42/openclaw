import { describe, expect, it } from "vitest";
import { BridgeError } from "../src/errors.js";
import { extractAfterMarker, extractAfterMarkerWithSnapshotFallback, makeMarker } from "../src/ui/extract.js";

describe("makeMarker", () => {
  it("is deterministic for same rid and secret", () => {
    const markerA = makeMarker("rid-1", "secret");
    const markerB = makeMarker("rid-1", "secret");
    expect(markerA).toBe(markerB);
  });

  it("changes with request id", () => {
    const markerA = makeMarker("rid-1", "secret");
    const markerB = makeMarker("rid-2", "secret");
    expect(markerA).not.toBe(markerB);
  });
});

describe("extractAfterMarker", () => {
  it("extracts text after the last marker occurrence", () => {
    const marker = "[[OC=test.sig]]";
    const text = `before ${marker} old answer ${marker} final answer Regenerate ▍`;
    const extracted = extractAfterMarker(text, marker, {
      uiLabelRegenerate: "Regenerate",
      uiLabelContinue: "Continue generating",
    });

    expect(extracted).toBe("final answer");
  });

  it("throws when bridge marker is missing from scraped text", () => {
    expect(() =>
      extractAfterMarker("no marker", "[[OC=x]]", {
        uiLabelRegenerate: "Regenerate",
        uiLabelContinue: "Continue generating",
      }),
    ).toThrowError(BridgeError);
  });

  it("uses strict marker extraction when marker is embedded in a larger prompt anchor", () => {
    const anchor = `Analyse CTO\n[[OC=test.sig]]\nNe recopie pas le contexte`;
    const fullText = `intro\n[[OC=old.sig]]\nancienne réponse\n[[OC=test.sig]]\nRéponse CTO complète`;
    const extracted = extractAfterMarker(fullText, anchor, {
      uiLabelRegenerate: "Regenerate",
      uiLabelContinue: "Continue generating",
    });

    expect(extracted).toBe("Réponse CTO complète");
  });

  it("returns marker_not_found when embedded bridge marker is absent from scraped text", () => {
    const anchor = `Analyse CTO\n[[OC=test.sig]]\nNe recopie pas le contexte`;

    try {
      extractAfterMarker("Réponse CTO complète", anchor, {
        uiLabelRegenerate: "Regenerate",
        uiLabelContinue: "Continue generating",
      });
      throw new Error("expected extractAfterMarker to throw");
    } catch (error) {
      const bridgeError = error as BridgeError;
      expect(bridgeError.code).toBe("ui_error");
      expect(bridgeError.details?.reason).toBe("marker_not_found");
    }
  });

  it("keeps legacy fallback behavior when marker is plain prompt text", () => {
    const extracted = extractAfterMarker("no marker", "plain prompt marker", {
      uiLabelRegenerate: "Regenerate",
      uiLabelContinue: "Continue generating",
    });

    expect(extracted).toBe("no marker");
  });

  it("throws ui_error when extraction cannot find meaningful text", () => {
    expect(() =>
      extractAfterMarker("   \n  ", "[[OC=x]]", {
        uiLabelRegenerate: "Regenerate",
        uiLabelContinue: "Continue generating",
      }),
    ).toThrowError(BridgeError);

    try {
      extractAfterMarker("   \n  ", "[[OC=x]]", {
        uiLabelRegenerate: "Regenerate",
        uiLabelContinue: "Continue generating",
      });
    } catch (error) {
      const bridgeError = error as BridgeError;
      expect(bridgeError.code).toBe("ui_error");
      expect(["marker_not_found", "response_not_ready", "extraction_failed"]).toContain(
        bridgeError.details?.reason,
      );
    }
  });

  it("cleans UI labels and typing cursor from extracted text", () => {
    const marker = "[[OC=test.sig]]";
    const text = `${marker} answer line Continue generating Regenerate response ▍`;

    const extracted = extractAfterMarker(text, marker, {
      uiLabelRegenerate: "Regenerate",
      uiLabelContinue: "Continue generating",
    });

    expect(extracted).toBe("answer line");
  });

  it("uses the last marker occurrence when marker is echoed in the response", () => {
    const marker = "[[OC=test.sig]]";
    const text = `${marker} Answer with echoed marker ${marker} final segment`;

    const extracted = extractAfterMarker(text, marker, {
      uiLabelRegenerate: "Regenerate",
      uiLabelContinue: "Continue generating",
    });

    expect(extracted).toBe("final segment");
  });

  it("filters ChatGPT Pro UI artefacts from extracted response", () => {
    const marker = "[[OC=test.sig]]";
    const text = `${marker}\nPro\naffordance\nWriting Tools\nRéponse finale`;

    const extracted = extractAfterMarker(text, marker, {
      uiLabelRegenerate: "Regenerate",
      uiLabelContinue: "Continue generating",
    });

    expect(extracted).toBe("Réponse finale");
  });

  it("throws when extracted content is only Pro UI artefacts", () => {
    const marker = "[[OC=test.sig]]";
    const text = `${marker}\nPro\naffordance\nWriting Tools`;

    expect(() =>
      extractAfterMarker(text, marker, {
        uiLabelRegenerate: "Regenerate",
        uiLabelContinue: "Continue generating",
      }),
    ).toThrowError(BridgeError);
  });

  it("rejects object-replacement artefacts as non-meaningful responses", () => {
    const marker = "[[OC=test.sig]]";
    const text = `${marker}\n\uFFFC`;

    expect(() =>
      extractAfterMarker(text, marker, {
        uiLabelRegenerate: "Regenerate",
        uiLabelContinue: "Continue generating",
      }),
    ).toThrowError(BridgeError);
  });

  it("rejects zero-width artefacts as non-meaningful responses", () => {
    const marker = "[[OC=test.sig]]";
    const text = `${marker}\n\u200B\u200C\u200D\u2060`;

    expect(() =>
      extractAfterMarker(text, marker, {
        uiLabelRegenerate: "Regenerate",
        uiLabelContinue: "Continue generating",
      }),
    ).toThrowError(BridgeError);
  });

  it("rejects prompt-only text as non-response", () => {
    const marker = "First line\nSecond line\nThird line";

    expect(() =>
      extractAfterMarker(marker, marker, {
        uiLabelRegenerate: "Regenerate",
        uiLabelContinue: "Continue generating",
      }),
    ).toThrowError(BridgeError);
  });

  it("rejects normalized prompt-echo fragments", () => {
    const marker = "Header line\nDetailed instruction line\nAnother line";
    const echoed = "Detailed   instruction line\nAnother line";

    expect(() =>
      extractAfterMarker(echoed, marker, {
        uiLabelRegenerate: "Regenerate",
        uiLabelContinue: "Continue generating",
      }),
    ).toThrowError(BridgeError);
  });

  it("strips leading FILE_CONTEXT echo artefacts and keeps the full answer", () => {
    const marker = "[[OC=test.sig]]";
    const text = `${marker}
[FILE_CONTEXT]
The following file contents were injected by the local bridge.
Treat them as authoritative snapshots of the local filesystem.
files: 1
--- BEGIN FILE: sample.md ---
path: /tmp/sample.md
sample content
--- END FILE: sample.md ---
Réponse CTO complète
Point 2
Point 3`;

    const extracted = extractAfterMarker(text, marker, {
      uiLabelRegenerate: "Regenerate",
      uiLabelContinue: "Continue generating",
    });

    expect(extracted).toBe("Réponse CTO complète\nPoint 2\nPoint 3");
  });

  it("rejects extracted payload that still contains a leaked bridge marker", () => {
    const marker = "[[OC=current.sig]]";
    const text = `${marker}\nIntro\n[[OC=old.sig]]\nArtefact`;

    expect(() =>
      extractAfterMarker(text, marker, {
        uiLabelRegenerate: "Regenerate",
        uiLabelContinue: "Continue generating",
      }),
    ).toThrowError(BridgeError);
  });
});

describe("extractAfterMarkerWithSnapshotFallback", () => {
  it("uses marker extraction when marker is present", () => {
    const marker = "[[OC=current.sig]]";
    const fullText = `${marker}\nRéponse finale`;

    const extracted = extractAfterMarkerWithSnapshotFallback(
      fullText,
      marker,
      {
        uiLabelRegenerate: "Regenerate",
        uiLabelContinue: "Continue generating",
      },
      { previousFullText: "ancien état" },
    );

    expect(extracted).toEqual({
      text: "Réponse finale",
      mode: "marker",
    });
  });

  it("keeps strict marker mode when bridge marker is missing", () => {
    const marker = "Analyse\n[[OC=current.sig]]\nContexte";
    const previous = "Ancienne conversation";
    const fullText = `${previous}\nRéponse CTO complète`;

    try {
      extractAfterMarkerWithSnapshotFallback(
        fullText,
        marker,
        {
          uiLabelRegenerate: "Regenerate",
          uiLabelContinue: "Continue generating",
        },
        { previousFullText: previous },
      );
      throw new Error("expected strict marker extraction to throw");
    } catch (error) {
      const bridgeError = error as BridgeError;
      expect(bridgeError.code).toBe("ui_error");
      expect(bridgeError.details?.reason).toBe("marker_not_found");
    }
  });

  it("uses snapshot delta for legacy anchors without bridge marker", () => {
    const marker = "very very long marker first line\nline2\nline3";
    const previous = "very very long marker first line\nline2";
    const fullText = `${previous}\nRéponse CTO complète\nvery very long marker first line`;

    const extracted = extractAfterMarkerWithSnapshotFallback(
      fullText,
      marker,
      {
        uiLabelRegenerate: "Regenerate",
        uiLabelContinue: "Continue generating",
      },
      { previousFullText: previous },
    );

    expect(extracted.mode).toBe("snapshot_delta");
    expect(extracted.text).toContain("Réponse CTO complète");
  });

  it("keeps strict failure when bridge marker is missing and snapshot is empty", () => {
    const marker = "Analyse\n[[OC=current.sig]]\nContexte";

    expect(() =>
      extractAfterMarkerWithSnapshotFallback(
        "Réponse CTO complète",
        marker,
        {
          uiLabelRegenerate: "Regenerate",
          uiLabelContinue: "Continue generating",
        },
        { previousFullText: "" },
      )).toThrowError(BridgeError);
  });
});
