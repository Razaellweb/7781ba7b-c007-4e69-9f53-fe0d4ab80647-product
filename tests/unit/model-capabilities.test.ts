import { describe, expect, it } from "vitest";
import { deriveCapabilities, formatContextWindow, capabilitySource } from "../../lib/server/model-capabilities";

describe("model capability derivation", () => {
  it("formats context windows concisely", () => {
    expect(formatContextWindow(32768)).toBe("32k");
    expect(formatContextWindow(128000)).toBe("128k");
    expect(formatContextWindow(1048576)).toBe("1M");
    expect(formatContextWindow(null)).toBeNull();
    expect(formatContextWindow(0)).toBeNull();
  });

  it("reports confirmed support from provider metadata", () => {
    const capabilities = deriveCapabilities({
      contextLength: 1048576,
      inputModalities: ["text", "image"],
      supportedParameters: ["tools", "temperature"],
      metadataPresent: true,
      syncStatus: "current",
      availability: "available",
    });
    expect(capabilities.contextWindow.label).toBe("1M");
    expect(capabilities.tools).toBe("supported");
    expect(capabilities.vision).toBe("supported");
    expect(capabilities.source).toBe("provider");
  });

  it("distinguishes confirmed absence from missing metadata", () => {
    const confirmed = deriveCapabilities({
      contextLength: 32768,
      inputModalities: ["text"],
      supportedParameters: ["temperature"],
      metadataPresent: true,
      syncStatus: "current",
      availability: "available",
    });
    expect(confirmed.tools).toBe("unsupported");
    expect(confirmed.vision).toBe("unsupported");

    const missing = deriveCapabilities({
      contextLength: null,
      inputModalities: null,
      supportedParameters: null,
      metadataPresent: false,
      syncStatus: "never",
      availability: null,
    });
    expect(missing.tools).toBe("unknown");
    expect(missing.vision).toBe("unknown");
    expect(missing.contextWindow.label).toBeNull();
    expect(missing.source).toBe("none");
  });

  it("labels reused metadata as cached rather than fresh", () => {
    expect(capabilitySource({ metadataPresent: true, syncStatus: "stale", availability: "stale" })).toBe("cached");
    expect(capabilitySource({ metadataPresent: true, syncStatus: "current", availability: "unavailable" })).toBe("cached");
  });
});
