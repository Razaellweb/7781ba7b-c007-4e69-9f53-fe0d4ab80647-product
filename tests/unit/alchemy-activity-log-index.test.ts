import { describe, expect, it } from "vitest";
import { parseAddressActivity } from "../../lib/server/alchemy";

// Alchemy's Address Activity payload carries a token transfer's log index inside
// `activity.log.logIndex`, not at the top level. Reading it as 0 gave the webhook
// and the polling sweep different identities for one transfer (…:0 vs …:63), so
// the same deposit could be recorded and credited twice.

// Shape of a real delivery (Robinhood Chain USDG, 1 token, tx 0xabb8d9e0…).
const delivery = {
  webhookId: "wh_x",
  id: "whevt_x",
  type: "ADDRESS_ACTIVITY",
  event: {
    network: "ROBINHOOD_MAINNET",
    activity: [{
      fromAddress: "0xe6d7cfd248cda5d4fa10070a502daa49cc5f2bd9",
      toAddress: "0x099a6ecf400a89a75e2bb0ce87e0ab145d9c2406",
      blockNum: "0x6676155",
      hash: "0xabb8d9e0af873093d78666783aeff1b0d3d1bbcf0d2256f2237efacc92d8b77f",
      category: "token",
      asset: "USDG",
      rawContract: { rawValue: "0x00000000000000000000000000000000000000000000000000000000000f4240", address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", decimals: 6 },
      log: {
        address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
        logIndex: "0x3f",
        transactionHash: "0xabb8d9e0af873093d78666783aeff1b0d3d1bbcf0d2256f2237efacc92d8b77f",
        blockNumber: "0x6676155",
        removed: false,
      },
    }],
  },
};

describe("parseAddressActivity log index", () => {
  it("reads the log index Alchemy nests under activity.log", () => {
    const [activity] = parseAddressActivity(delivery);
    expect(activity.logIndex).toBe(63);
  });

  it("still accepts a top-level logIndex, and defaults to 0 when there is none", () => {
    const top = structuredClone(delivery) as any;
    delete top.event.activity[0].log;
    top.event.activity[0].logIndex = "0x5";
    expect(parseAddressActivity(top)[0].logIndex).toBe(5);
    delete top.event.activity[0].logIndex;
    expect(parseAddressActivity(top)[0].logIndex).toBe(0);
  });
});
