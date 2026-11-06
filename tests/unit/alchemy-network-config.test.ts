import { afterEach, describe, expect, it, vi } from "vitest";

// ALCHEMY_NETWORK feeds two different formats: the RPC hostname
// (`robinhood-mainnet.g.alchemy.com`) and the network label Alchemy puts on
// webhook deliveries (`ROBINHOOD_MAINNET`). Owners also paste the full RPC URL
// from the Alchemy dashboard into it. All three must resolve to one network.
//
// ALCHEMY_RPC_URL is the other supported shape: a complete endpoint that is used
// exactly as given (no key/network segment appended). A bare ALCHEMY_API_KEY with
// no usable network must stay DISABLED with a distinct reason rather than pretend
// monitoring works.

const URL_KEY = "urlkeyabc123";
const RPC_URL = `https://robinhood-mainnet.g.alchemy.com/v2/${URL_KEY}`;

afterEach(() => {
  vi.unstubAllEnvs();
});

async function load(env: Record<string, string | undefined>) {
  vi.stubEnv("ALCHEMY_API_KEY", "apikey");
  vi.stubEnv("ALCHEMY_RPC_URL", "");
  vi.stubEnv("ALCHEMY_NETWORK", "");
  vi.stubEnv("FUNDING_ALCHEMY_NETWORK", "");
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value ?? "");
  const { alchemyConfig } = await import("../../lib/server/config");
  const { networkMatchesConfiguredChain } = await import("../../lib/server/alchemy");
  return { cfg: alchemyConfig(), matches: networkMatchesConfiguredChain };
}

describe("ALCHEMY_NETWORK", () => {
  it("builds the RPC URL from a network name", async () => {
    const { cfg } = await load({ ALCHEMY_NETWORK: "robinhood-mainnet" });
    expect(cfg.network).toBe("robinhood-mainnet");
    expect(cfg.rpcUrl).toBe("https://robinhood-mainnet.g.alchemy.com/v2/apikey");
  });

  it("accepts the full RPC URL pasted from the Alchemy dashboard", async () => {
    const { cfg } = await load({ ALCHEMY_NETWORK: RPC_URL });
    expect(cfg.network).toBe("robinhood-mainnet");
    expect(cfg.rpcUrl).toBe(RPC_URL);
  });

  it("accepts Alchemy's webhook spelling as the configured name", async () => {
    const { cfg } = await load({ ALCHEMY_NETWORK: "ROBINHOOD_MAINNET" });
    expect(cfg.network).toBe("robinhood-mainnet");
    expect(cfg.rpcUrl).toBe("https://robinhood-mainnet.g.alchemy.com/v2/apikey");
  });

  it("lets ALCHEMY_RPC_URL override everything", async () => {
    const { cfg } = await load({ ALCHEMY_NETWORK: "robinhood-mainnet", ALCHEMY_RPC_URL: "https://rpc.example/v2/x" });
    expect(cfg.rpcUrl).toBe("https://rpc.example/v2/x");
  });

  it.each(["robinhood-mainnet", RPC_URL, "ROBINHOOD_MAINNET"])("matches Alchemy's webhook network label when configured as %s", async (configured) => {
    const { matches } = await load({ ALCHEMY_NETWORK: configured });
    expect(matches("ROBINHOOD_MAINNET")).toBe(true);
    expect(matches("robinhood-mainnet")).toBe(true);
    expect(matches("ETH_MAINNET")).toBe(false);
  });
});

describe("ALCHEMY_RPC_URL", () => {
  it("enables monitoring from the full endpoint alone, used intact", async () => {
    const { cfg } = await load({ ALCHEMY_API_KEY: undefined, ALCHEMY_RPC_URL: RPC_URL });
    expect(cfg.rpcUrl).toBe(RPC_URL);
    expect(cfg.enabled).toBe(true);
    expect(cfg.apiKeyConfigured).toBe(true);
    expect(cfg.network).toBe("robinhood-mainnet");
    expect(cfg.unconfiguredReason).toBeNull();
  });

  it("never appends a key or network segment to an explicit endpoint", async () => {
    const { cfg } = await load({ ALCHEMY_NETWORK: "robinhood-mainnet", ALCHEMY_RPC_URL: "https://rpc.example/v2/x" });
    expect(cfg.rpcUrl).toBe("https://rpc.example/v2/x");
    expect(cfg.rpcUrl).not.toContain("apikey");
    expect(cfg.rpcUrl).not.toContain("robinhood-mainnet");
  });

  it("reports an invalid endpoint distinctly", async () => {
    const { cfg } = await load({ ALCHEMY_API_KEY: undefined, ALCHEMY_RPC_URL: "not-a-url" });
    expect(cfg.enabled).toBe(false);
    expect(cfg.unconfiguredReason).toBe("alchemy_rpc_url_invalid");
  });
});

describe("configuration reasons", () => {
  it("reports a missing key and endpoint distinctly", async () => {
    const { cfg } = await load({ ALCHEMY_API_KEY: undefined });
    expect(cfg.enabled).toBe(false);
    expect(cfg.apiKeyConfigured).toBe(false);
    expect(cfg.unconfiguredReason).toBe("alchemy_not_configured");
    expect(cfg.message).toBeTruthy();
  });

  it("keeps a bare key without a network disabled with a network-specific reason", async () => {
    const { cfg } = await load({ ALCHEMY_NETWORK: undefined });
    expect(cfg.enabled).toBe(false);
    expect(cfg.apiKeyConfigured).toBe(true);
    expect(cfg.rpcUrl).toBeUndefined();
    expect(cfg.unconfiguredReason).toBe("alchemy_network_not_configured");
  });

  it("reports an unparseable network distinctly", async () => {
    const { cfg } = await load({ ALCHEMY_NETWORK: "not a network!" });
    expect(cfg.enabled).toBe(false);
    expect(cfg.unconfiguredReason).toBe("alchemy_network_invalid");
  });
});
