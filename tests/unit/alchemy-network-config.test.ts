import { afterEach, describe, expect, it, vi } from "vitest";

// ALCHEMY_NETWORK feeds two different formats: the RPC hostname
// (`robinhood-mainnet.g.alchemy.com`) and the network label Alchemy puts on
// webhook deliveries (`ROBINHOOD_MAINNET`). Owners also paste the full RPC URL
// from the Alchemy dashboard into it. All three must resolve to one network.

const URL_KEY = "urlkeyabc123";
const RPC_URL = `https://robinhood-mainnet.g.alchemy.com/v2/${URL_KEY}`;

afterEach(() => {
  vi.unstubAllEnvs();
});

async function load(env: Record<string, string | undefined>) {
  vi.stubEnv("ALCHEMY_API_KEY", "apikey");
  vi.stubEnv("ALCHEMY_RPC_URL", "");
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
