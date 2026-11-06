import { afterEach, describe, expect, it, vi } from "vitest";

// The polling sweep's eth_getLogs must not go through an endpoint that caps the
// block range below one sweep window (Alchemy's free plan allows 10 blocks), and
// must never scan a different chain than the one deposits are credited on.

const ALCHEMY = "https://robinhood-mainnet.g.alchemy.com/v2/key";
const PUBLIC = "https://rpc.mainnet.chain.robinhood.com";
const TOKEN = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const WALLET = "0x1111111111111111111111111111111111111111";

function stubRpc(chainIdByUrl: Record<string, number>) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
    const { method } = JSON.parse(init.body);
    calls.push({ url, method });
    const result = method === "eth_chainId" ? `0x${(chainIdByUrl[url] ?? 0).toString(16)}` : method === "eth_blockNumber" ? "0x64" : [];
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  }));
  return calls;
}

async function load(env: Record<string, string>) {
  for (const key of ["ALCHEMY_RPC_URL", "ROBINHOOD_RPC_URL", "FUNDING_LOGS_RPC_URL", "ALCHEMY_API_KEY"]) vi.stubEnv(key, "");
  vi.stubEnv("ALCHEMY_NETWORK", ALCHEMY);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return import("../../lib/server/alchemy");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("log-scan endpoint", () => {
  it("scans logs and reads the head on the chain's public RPC when configured", async () => {
    const calls = stubRpc({ [PUBLIC]: 4663, [ALCHEMY]: 4663 });
    const alchemy = await load({ ROBINHOOD_RPC_URL: PUBLIC });
    expect(await alchemy.getLogScanHead(4663)).toBe(100n);
    await alchemy.fetchIncomingTokenLogs({ tokenAddress: TOKEN, toAddress: WALLET, fromBlock: 1n, toBlock: 100n });
    expect(calls.map((c) => c.url)).toEqual([PUBLIC, PUBLIC, PUBLIC]);
  });

  it("prefers FUNDING_LOGS_RPC_URL, and falls back to Alchemy when nothing else is set", async () => {
    let calls = stubRpc({ "https://logs.example": 4663 });
    let alchemy = await load({ ROBINHOOD_RPC_URL: PUBLIC, FUNDING_LOGS_RPC_URL: "https://logs.example" });
    await alchemy.fetchIncomingTokenLogs({ tokenAddress: TOKEN, toAddress: WALLET, fromBlock: 1n, toBlock: 2n });
    expect(calls[0].url).toBe("https://logs.example");

    calls = stubRpc({ [ALCHEMY]: 4663 });
    alchemy = await load({});
    await alchemy.fetchIncomingTokenLogs({ tokenAddress: TOKEN, toAddress: WALLET, fromBlock: 1n, toBlock: 2n });
    expect(calls[0].url).toBe(ALCHEMY);
  });

  it("refuses a log-scan endpoint on another chain", async () => {
    stubRpc({ [PUBLIC]: 1 });
    const alchemy = await load({ ROBINHOOD_RPC_URL: PUBLIC });
    await expect(alchemy.getLogScanHead(4663)).rejects.toMatchObject({ code: "ALCHEMY_WRONG_CHAIN" });
  });
});
