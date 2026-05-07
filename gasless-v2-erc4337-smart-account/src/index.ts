import "dotenv/config";
import { alchemy, base } from "@account-kit/infra";
import { createModularAccountV2Client } from "@account-kit/smart-contracts";
import { LocalAccountSigner } from "@aa-sdk/core";
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  maxUint256,
  parseUnits,
  type Hex,
} from "viem";

const { PRIVATE_KEY, ZERO_EX_API_KEY, ALCHEMY_API_KEY } = process.env;
if (!PRIVATE_KEY) throw new Error("missing PRIVATE_KEY");
if (!ZERO_EX_API_KEY) throw new Error("missing ZERO_EX_API_KEY");
if (!ALCHEMY_API_KEY) throw new Error("missing ALCHEMY_API_KEY");

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const WETH = "0x4200000000000000000000000000000000000006" as const;
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;
const SELL_AMOUNT = parseUnits("1", 6); // 1 USDC

const headers = {
  "Content-Type": "application/json",
  "0x-api-key": ZERO_EX_API_KEY,
  "0x-version": "v2",
};

async function fetchJson(res: Response) {
  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

async function main() {
  // 1. Create ERC-4337 smart wallet (Alchemy Modular Account v2)
  const signer = LocalAccountSigner.privateKeyToAccountSigner(
    `0x${PRIVATE_KEY}` as Hex
  );

  const client = await createModularAccountV2Client({
    mode: "default",
    chain: base,
    transport: alchemy({ apiKey: ALCHEMY_API_KEY }),
    signer,
  });

  const smartWalletAddress = client.account.address;
  console.log("Smart wallet address:", smartWalletAddress);

  const publicClient = createPublicClient({
    chain: base,
    transport: http(`https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`),
  });

  // 2. Deploy smart wallet if needed — 0x needs to call isValidSignature() on-chain
  const deployedCode = await publicClient.getCode({ address: smartWalletAddress });
  if (!deployedCode || deployedCode === "0x") {
    console.log("Deploying smart wallet + approving Permit2...");
    const { hash } = await client.sendUserOperation({
      uo: {
        target: USDC,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [PERMIT2, maxUint256],
        }),
        value: 0n,
      },
    });
    const receipt = await client.waitForUserOperationTransaction({ hash });
    console.log("Deployed:", receipt, "\n");
  } else {
    console.log("Smart wallet already deployed.\n");

    const permit2Allowance = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "allowance",
      args: [smartWalletAddress, PERMIT2],
    });

    if (permit2Allowance < SELL_AMOUNT) {
      console.log("Approving Permit2...");
      const { hash } = await client.sendUserOperation({
        uo: {
          target: USDC,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [PERMIT2, maxUint256],
          }),
          value: 0n,
        },
      });
      const receipt = await client.waitForUserOperationTransaction({ hash });
      console.log("Permit2 approved:", receipt, "\n");
    }
  }

  // 3. Check USDC balance
  const usdcBalance = await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [smartWalletAddress],
  });
  console.log("USDC balance:", usdcBalance.toString(), "(raw, 6 decimals)\n");

  if (usdcBalance < SELL_AMOUNT) {
    throw new Error(
      `Insufficient USDC. Need ${SELL_AMOUNT}, have ${usdcBalance}.\nSend 1 USDC to ${smartWalletAddress} on Base.`
    );
  }

  // 4. Get gasless quote
  console.log("Fetching gasless quote...\n");
  const quoteParams = new URLSearchParams({
    chainId: "8453",
    sellToken: USDC,
    buyToken: WETH,
    sellAmount: SELL_AMOUNT.toString(),
    taker: smartWalletAddress,
  });

  const quote = await fetchJson(
    await fetch(`https://api.0x.org/gasless/quote?${quoteParams}`, { headers })
  );
  console.log("Buy amount:", quote.buyAmount);
  console.log("Min buy amount:", quote.minBuyAmount);
  console.log("Approval needed:", quote.issues?.allowance != null);
  console.log("Gasless approval available:", quote.approval != null, "\n");

  // 5. Sign approval (if needed) and trade
  //    signatureType 5 = Raw: passes bytes directly to EIP-1271 isValidSignature()
  let approvalDataToSubmit: object | undefined;

  if (quote.issues?.allowance != null) {
    if (quote.approval != null) {
      console.log("Signing gasless approval...");
      const approvalSig = await client.signTypedData({
        typedData: {
          types: quote.approval.eip712.types,
          domain: quote.approval.eip712.domain,
          message: quote.approval.eip712.message,
          primaryType: quote.approval.eip712.primaryType,
        },
      });
      approvalDataToSubmit = {
        type: quote.approval.type,
        eip712: quote.approval.eip712,
        signature: { signatureType: 5, signatureBytes: approvalSig },
      };
    } else {
      console.log("Gasless approval unavailable — using on-chain approval...");
      const { hash } = await client.sendUserOperation({
        uo: {
          target: USDC,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [quote.issues.allowance.spender, maxUint256],
          }),
          value: 0n,
        },
      });
      await client.waitForUserOperationTransaction({ hash });
      console.log("On-chain approval confirmed.\n");
    }
  }

  console.log("Signing trade...");
  const tradeSig = await client.signTypedData({
    typedData: {
      types: quote.trade.eip712.types,
      domain: quote.trade.eip712.domain,
      message: quote.trade.eip712.message,
      primaryType: quote.trade.eip712.primaryType,
    },
  });
  const tradeDataToSubmit = {
    type: quote.trade.type,
    eip712: quote.trade.eip712,
    signature: { signatureType: 5, signatureBytes: tradeSig },
  };

  // 6. Submit gasless swap
  console.log("\nSubmitting gasless swap...\n");
  const submitBody: Record<string, unknown> = {
    trade: tradeDataToSubmit,
    chainId: 8453,
  };
  if (approvalDataToSubmit) {
    submitBody.approval = approvalDataToSubmit;
  }

  const { tradeHash } = await fetchJson(
    await fetch("https://api.0x.org/gasless/submit", {
      method: "POST",
      headers,
      body: JSON.stringify(submitBody),
    })
  );
  console.log("Trade hash:", tradeHash);

  // 7. Poll for status
  console.log("\nPolling for status...\n");
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));

    const status = await fetchJson(
      await fetch(
        `https://api.0x.org/gasless/status/${tradeHash}?chainId=8453`,
        { headers }
      )
    );
    console.log(`[${i + 1}/20] Status: ${status.status}`);

    if (status.status === "confirmed" || status.status === "succeeded") {
      console.log("\nTransaction confirmed!");
      console.log("Transactions:", JSON.stringify(status.transactions, null, 2));
      return;
    }
    if (status.status === "failed") {
      throw new Error(`Transaction failed: ${JSON.stringify(status)}`);
    }
  }

  console.log("Timed out waiting for confirmation.");
}

main().catch(console.error);
