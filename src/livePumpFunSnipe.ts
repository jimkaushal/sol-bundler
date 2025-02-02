import {
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import promptSync from "prompt-sync";
import { connection, payer } from "../config";
import { loadKeypairs } from "./createKeys";
import { getMint, Mint } from "@solana/spl-token";
import fs from "fs";
import path from "path";

import { getLatestBlockhashWithRetry } from "./retryHelpers";
import { sendBundle } from "./bundleSender";

// Create prompt instance
const prompt = promptSync();

/**
 * (A) Helper: Load the LUT account from keyInfo.json (if available)
 */
async function getLUTAccount(): Promise<any | null> {
  try {
    const keyInfoPath = path.join(process.cwd(), "src", "keyInfo.json");
    if (!fs.existsSync(keyInfoPath)) {
      console.log("keyInfo.json not found.");
      return null;
    }
    const rawData = fs.readFileSync(keyInfoPath, "utf8");
    const data = JSON.parse(rawData);
    if (!data.addressLUT) {
      console.log("No LUT address found in keyInfo.json.");
      return null;
    }
    const lutPubkey = new PublicKey(data.addressLUT);
    const lutAccountResponse = await connection.getAddressLookupTable(
      lutPubkey
    );
    if (!lutAccountResponse.value) {
      console.log("LUT account not found on chain.");
      return null;
    }
    console.log("LUT account loaded:", lutPubkey.toString());
    return lutAccountResponse.value;
  } catch (err) {
    console.error("Error loading LUT account:", err);
    return null;
  }
}

/**
 * (A) Helper: Fetch token mint info from on‑chain data.
 */
async function getTokenMintInfo(mintAddress: string): Promise<Mint> {
  try {
    const mintInfo = await getMint(connection, new PublicKey(mintAddress));
    return mintInfo;
  } catch (err) {
    console.error("Error fetching token mint info:", err);
    throw err;
  }
}

/**
 * (Placeholder for Pump.fun Swap Instruction)
 * Create a swap instruction to buy tokens (i.e. swap SOL -> Token)
 */
function createPumpFunSwapInstructionForBuy(params: {
  buyerPubkey: PublicKey;
  tokenMint: PublicKey;
  solAmount: number; // lamports
}): TransactionInstruction {
  const { buyerPubkey, tokenMint, solAmount } = params;
  // TODO: Replace with actual Pump.fun swap instruction data.
  const instructionData = Buffer.alloc(0);
  return new TransactionInstruction({
    keys: [
      { pubkey: buyerPubkey, isSigner: true, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      // Add any additional accounts as required.
    ],
    programId: new PublicKey("PumPFun1111111111111111111111111111111111"), // Dummy program ID
    data: instructionData,
  });
}

/**
 * (Placeholder for Pump.fun Swap Instruction)
 * Create a swap instruction to sell tokens (i.e. swap Token -> SOL)
 */
function createPumpFunSwapInstructionForSell(params: {
  buyerPubkey: PublicKey;
  tokenMint: PublicKey;
  tokenAmount: number;
}): TransactionInstruction {
  const { buyerPubkey, tokenMint, tokenAmount } = params;
  // TODO: Replace with actual Pump.fun swap instruction data.
  const instructionData = Buffer.alloc(0);
  return new TransactionInstruction({
    keys: [
      { pubkey: buyerPubkey, isSigner: true, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
    ],
    programId: new PublicKey("PumPFun1111111111111111111111111111111111"),
    data: instructionData,
  });
}

/**
 * (Placeholder) Get token balance for a buyer wallet.
 * In a full implementation, use @solana/spl-token’s getAssociatedTokenAddress and getAccount.
 */
async function getTokenBalanceForBuyer(
  buyerPubkey: PublicKey,
  tokenMint: PublicKey
): Promise<number> {
  // TODO: Implement actual token balance retrieval.
  return 1000; // Dummy value
}

/**
 * (Placeholder) Get current token price.
 * In a production implementation, you would fetch this from an on‑chain oracle or API.
 */
async function getTokenPrice(tokenMint: PublicKey): Promise<number> {
  const priceInput = prompt("Enter current token price (SOL per token): ");
  const price = parseFloat(priceInput);
  if (isNaN(price)) {
    console.error("Invalid price input; defaulting to 1.0 SOL per token.");
    return 1.0;
  }
  return price;
}

/**
 * (C) Combined Live Buy-and-Sell (Sniping) Function for Pump.fun
 *
 * - Prompts for the token contract address.
 * - Fetches the token mint info and LUT (if available).
 * - Uses the 24 buyer wallets to execute live buy transactions.
 * - Immediately prepares sell transactions.
 * - Waits until either:
 *      a) The token price drops by 10% from the recorded purchase price, or
 *      b) The user explicitly enters "sell".
 * - Then, it sends the sell transactions.
 * - Finally, it optionally reclaims leftover SOL from buyer wallets.
 */
export async function liveBuyAndSellPumpFun() {
  // Step 1: Prompt for the token contract (mint) address.
  const tokenAddressInput = prompt("Enter the token contract address: ");
  let tokenMint: PublicKey;
  try {
    tokenMint = new PublicKey(tokenAddressInput.trim());
  } catch (err) {
    console.error("Invalid token address");
    return;
  }

  // Step 2: Fetch token mint info and LUT account.
  const mintInfo = await getTokenMintInfo(tokenAddressInput);
  console.log("Token mint info fetched:", mintInfo);
  const lutAccount = await getLUTAccount();

  // Step 3: Load buyer wallets and prepare live buy transactions.
  const buyerKeypairs = loadKeypairs();
  const buyTxs: VersionedTransaction[] = [];
  const latestBlockhashResponse = await getLatestBlockhashWithRetry();
  const { blockhash } = latestBlockhashResponse;

  for (const buyer of buyerKeypairs) {
    const balance = await connection.getBalance(buyer.publicKey);
    if (balance < 10000) {
      console.log(
        `Skipping wallet ${buyer.publicKey.toString()} due to insufficient SOL.`
      );
      continue;
    }
    const solToSpend = balance - 10000; // Keep a small reserve for fees.
    const swapIx = createPumpFunSwapInstructionForBuy({
      buyerPubkey: buyer.publicKey,
      tokenMint,
      solAmount: solToSpend,
    });

    // Use LUT if available.
    const message = new TransactionMessage({
      payerKey: buyer.publicKey,
      recentBlockhash: blockhash,
      instructions: [swapIx],
    }).compileToV0Message(lutAccount ? [lutAccount] : []);
    const tx = new VersionedTransaction(message);
    tx.sign([buyer]);
    buyTxs.push(tx);
  }

  if (buyTxs.length === 0) {
    console.error("No valid buy transactions to send.");
    return;
  }
  console.log("Sending live buy transactions on Pump.fun...");
  await sendBundle(buyTxs);
  console.log("Live buy transactions sent successfully!");

  // Step 4: Record purchase price.
  const purchasePriceInput = prompt(
    "Enter the purchase price (SOL per token) as observed after buy: "
  );
  const purchasePrice = parseFloat(purchasePriceInput);
  if (isNaN(purchasePrice) || purchasePrice <= 0) {
    console.error("Invalid purchase price input. Aborting sell sequence.");
    return;
  }
  console.log(`Recorded purchase price: ${purchasePrice} SOL per token.`);

  // Step 5: Prepare sell transactions using buyer wallets.
  const sellTxs: VersionedTransaction[] = [];
  const latestBlockhashResponse2 = await getLatestBlockhashWithRetry();
  const { blockhash: sellBlockhash } = latestBlockhashResponse2;
  for (const buyer of buyerKeypairs) {
    // Retrieve the buyer's token balance.
    const tokenBalance = await getTokenBalanceForBuyer(
      buyer.publicKey,
      tokenMint
    );
    if (tokenBalance <= 0) {
      console.log(
        `Skipping wallet ${buyer.publicKey.toString()} due to zero token balance.`
      );
      continue;
    }
    const swapIx = createPumpFunSwapInstructionForSell({
      buyerPubkey: buyer.publicKey,
      tokenMint,
      tokenAmount: tokenBalance,
    });

    const message = new TransactionMessage({
      payerKey: buyer.publicKey,
      recentBlockhash: sellBlockhash,
      instructions: [swapIx],
    }).compileToV0Message(lutAccount ? [lutAccount] : []);
    const tx = new VersionedTransaction(message);
    tx.sign([buyer]);
    sellTxs.push(tx);
  }

  if (sellTxs.length === 0) {
    console.error("No valid sell transactions prepared.");
    return;
  }

  // Step 6: Wait for the sell trigger.
  // Either the token price drops 10% from purchase or the user explicitly commands a sell.
  console.log(
    "Monitoring for sell condition: a 10% price drop from purchase, or type 'sell' to trigger immediately."
  );
  let shouldSell = false;
  while (!shouldSell) {
    const currentPrice = await getTokenPrice(tokenMint);
    console.log(`Current price: ${currentPrice} SOL per token.`);
    if (currentPrice <= purchasePrice * 0.9) {
      console.log("Detected a 10% price drop. Triggering sell...");
      shouldSell = true;
      break;
    }
    const command = prompt(
      "Type 'sell' to execute sell transactions immediately, or press Enter to continue monitoring: "
    );
    if (command.trim().toLowerCase() === "sell") {
      console.log(
        "User triggered immediate sell. Proceeding with sell transactions..."
      );
      shouldSell = true;
      break;
    }
    // Short delay before the next check (e.g., 1 second)
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Step 7: Send sell transactions.
  console.log("Sending live sell transactions on Pump.fun...");
  await sendBundle(sellTxs);
  console.log("Live sell transactions sent successfully!");

  // Step 8: Optionally, reclaim any leftover SOL from buyer wallets.
  const reclaimChoice = prompt(
    "Do you want to reclaim leftover SOL from buyer wallets? (y/n): "
  );
  if (reclaimChoice.trim().toLowerCase() === "y") {
    const { reclaimBuyersSol } = await import("./reclaim");
    await reclaimBuyersSol();
  }
}
