// src/livePumpFunDevnet.ts
import {
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import promptSync from "prompt-sync";
import { connection, payer } from "../config";
import { loadKeypairs } from "./createKeys";
import { getMint, Mint } from "@solana/spl-token";
import fs from "fs";
import path from "path";
import { getLatestBlockhashWithRetry } from "./retryHelpers";
import { sendBundle } from "./bundleSender";

// Import any reusable functions from livePumpFun.ts if they are exported.
// For this example, we assume getTokenMintInfo and getLUTAccount are defined here.

const prompt = promptSync();

// *********************************************************************
// Tip Instruction Setup
// *********************************************************************
// IMPORTANT: Replace "YourTipAccountAddress" with a valid devnet account address
const tipAccount = new PublicKey(
  "GooZGQhudtVf4k45qjxxXs72E39dKHD9sn7evUd8eszE"
); // e.g. "F1pX...XYZ"
const tipIx = SystemProgram.transfer({
  fromPubkey: payer.publicKey,
  toPubkey: tipAccount,
  lamports: 1_000, // minimal tip amount (adjust as needed)
});
async function ensureTipAccountExists(): Promise<void> {
  const info = await connection.getAccountInfo(tipAccount);
  if (!info) {
    throw new Error(
      "Tip account does not exist. Please create and fund the tip account so that it is rent exempt on devnet."
    );
  }
}
// *********************************************************************
// Helper: chunkArray
// *********************************************************************
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

async function createTipTransaction(
  recentBlockhash: string,
  lutAccount: any | null
): Promise<VersionedTransaction> {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash,
    instructions: [tipIx],
  }).compileToV0Message(lutAccount ? [lutAccount] : []);
  const tipTx = new VersionedTransaction(message);
  tipTx.sign([payer]);
  return tipTx;
}

// *********************************************************************
// Common Helper Functions
// *********************************************************************
export async function getLUTAccount(): Promise<any | null> {
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

export async function getTokenMintInfo(mintAddress: string): Promise<Mint> {
  try {
    const mintInfo = await getMint(connection, new PublicKey(mintAddress));
    return mintInfo;
  } catch (err) {
    console.error("Error fetching token mint info:", err);
    throw err;
  }
}

export function createDummyBuyInstruction(params: {
  buyerPubkey: PublicKey;
}): TransactionInstruction {
  return SystemProgram.transfer({
    fromPubkey: params.buyerPubkey,
    toPubkey: params.buyerPubkey, // self-transfer is a no‑op
    lamports: 0,
  });
}

// *********************************************************************
// Devnet-Specific Swap Instruction Functions
// *********************************************************************
export function createDevnetSwapInstructionForBuy(params: {
  buyerPubkey: PublicKey;
  tokenMint: PublicKey;
  solAmount: number;
}): TransactionInstruction {
  const { buyerPubkey, tokenMint, solAmount } = params;
  const devnetProgramId = new PublicKey(
    "Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2"
  );
  // Use an 8-byte discriminator. Replace these bytes with a valid discriminator if available.
  const instructionData = Buffer.from([
    0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x11, 0x22,
  ]);
  return new TransactionInstruction({
    keys: [
      { pubkey: buyerPubkey, isSigner: true, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
    ],
    programId: devnetProgramId,
    data: instructionData,
  });
}

export function createDevnetSwapInstructionForSell(params: {
  buyerPubkey: PublicKey;
  tokenMint: PublicKey;
  tokenAmount: number;
}): TransactionInstruction {
  const { buyerPubkey, tokenMint, tokenAmount } = params;
  const devnetProgramId = new PublicKey(
    "Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2"
  );
  const instructionData = Buffer.from([
    0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x11, 0x22,
  ]);
  return new TransactionInstruction({
    keys: [
      { pubkey: buyerPubkey, isSigner: true, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
    ],
    programId: devnetProgramId,
    data: instructionData,
  });
}

// *********************************************************************
// Placeholder Functions for Testing
// *********************************************************************
async function getTokenBalanceForBuyer(
  buyerPubkey: PublicKey,
  tokenMint: PublicKey
): Promise<number> {
  // For testing, return a dummy value.
  return 1000;
}

export async function fundBuyerWallet(
  buyerPubkey: PublicKey,
  minLamports: number = 10_000_000,
  fundAmount: number = 40_000_000
): Promise<void> {
  const balance = await connection.getBalance(buyerPubkey);
  if (balance < minLamports) {
    console.log(
      `Wallet ${buyerPubkey.toString()} balance is ${balance} lamports; funding with ${fundAmount} lamports...`
    );
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: buyerPubkey,
        lamports: fundAmount,
      })
    );
    const signature = await connection.sendTransaction(transaction, [payer]);
    await connection.confirmTransaction(signature);
    console.log(
      `Wallet ${buyerPubkey.toString()} funded. New balance: ${await connection.getBalance(
        buyerPubkey
      )} lamports.`
    );
  } else {
    console.log(
      `Wallet ${buyerPubkey.toString()} already has sufficient balance (${balance} lamports).`
    );
  }
}

async function getTokenPrice(tokenMint: PublicKey): Promise<number> {
  const priceInput = prompt(
    "Enter current token price (SOL per token) [devnet test]: "
  );
  const price = parseFloat(priceInput);
  if (isNaN(price)) {
    console.error("Invalid price input; defaulting to 1.0 SOL per token.");
    return 1.0;
  }
  return price;
}

// *********************************************************************
// Combined Live Buy-and-Sell (Sniping) Function for Devnet Testing
// *********************************************************************
export async function liveBuyAndSellPumpFunDevnet() {
  // Step 1: Prompt for token contract address.
  const tokenAddressInput = prompt(
    "Enter the token contract address for devnet test: "
  );
  let tokenMint: PublicKey;
  try {
    tokenMint = new PublicKey(tokenAddressInput.trim());
  } catch (err) {
    console.error("Invalid token address");
    return;
  }

  // Step 2: Fetch mint info and LUT.
  const mintInfo = await getTokenMintInfo(tokenAddressInput);
  console.log("Token mint info fetched:", mintInfo);
  await ensureTipAccountExists();
  const lutAccount = await getLUTAccount();

  // Step 3: Load buyer wallets and prepare live buy transactions.
  const buyerKeypairs = loadKeypairs();
  // Define a custom type to hold our transaction info.
  type CustomTransaction = {
    tx: VersionedTransaction;
    originalInstructions: TransactionInstruction[];
    buyerPubkey: PublicKey;
    recentBlockhash: string;
    addressLookupTables: any[];
  };

  const buyTxs: CustomTransaction[] = [];
  const latestBlockhashResponse = await getLatestBlockhashWithRetry();
  const { blockhash } = latestBlockhashResponse;

  for (const buyer of buyerKeypairs) {
    await fundBuyerWallet(buyer.publicKey, 10_000_000, 40_000_000); // Ensure ~0.05 SOL
    const balance = await connection.getBalance(buyer.publicKey);
    if (balance < 10000) {
      console.log(
        `Skipping wallet ${buyer.publicKey.toString()} due to insufficient SOL even after funding.`
      );
      continue;
    }
    const solToSpend = balance - 10000;
    const swapIx = createDummyBuyInstruction({ buyerPubkey: buyer.publicKey });
    const originalInstructions = [swapIx];
    const compiledMessage = new TransactionMessage({
      payerKey: buyer.publicKey,
      recentBlockhash: blockhash,
      instructions: originalInstructions,
    }).compileToV0Message(lutAccount ? [lutAccount] : []);
    const tx = new VersionedTransaction(compiledMessage);
    tx.sign([buyer]);
    buyTxs.push({
      tx,
      originalInstructions,
      buyerPubkey: buyer.publicKey,
      recentBlockhash: blockhash,
      addressLookupTables: lutAccount ? [lutAccount] : [],
    });
  }

  if (buyTxs.length === 0) {
    console.error("No valid buy transactions to send.");
    return;
  }

  // Step 3.1: Chunk the transactions and insert tip instruction.
  const MAX_BUNDLE_SIZE = 4;
  const txChunks = chunkArray(buyTxs, MAX_BUNDLE_SIZE);

  for (const [i, chunk] of txChunks.entries()) {
    // Create a tip transaction for this chunk using the recent blockhash from the first buyer in the chunk.
    const tipTx = await createTipTransaction(
      chunk[0].recentBlockhash,
      chunk[0].addressLookupTables.length
        ? chunk[0].addressLookupTables[0]
        : null
    );

    // Prepend the tip transaction to the buyer transactions in this chunk.
    const bundleTxs = [tipTx, ...chunk.map((obj) => obj.tx)];

    console.log(
      `Sending bundle chunk ${i} with ${bundleTxs.length} transactions (including tip)...`
    );
    try {
      await sendBundle(bundleTxs);
      console.log(`Bundle chunk ${i} sent successfully via Jito!`);
    } catch (err) {
      console.error(`Error sending bundle chunk ${i} via Jito:`, err);
      console.log(
        "Falling back to individual transaction submission for this chunk..."
      );
      for (const tx of bundleTxs) {
        try {
          const rawTx = tx.serialize();
          const txid = await connection.sendRawTransaction(rawTx);
          console.log("Fallback: Transaction sent with txid:", txid);
          await connection.confirmTransaction(txid);
        } catch (fallbackErr) {
          console.error("Fallback error sending transaction:", fallbackErr);
        }
      }
    }
  }

  // Step 4: Record purchase price.
  const purchasePriceInput = prompt(
    "Enter the purchase price (SOL per token) observed on devnet: "
  );
  const purchasePrice = parseFloat(purchasePriceInput);
  if (isNaN(purchasePrice) || purchasePrice <= 0) {
    console.error("Invalid purchase price input. Aborting sell sequence.");
    return;
  }
  console.log(`Recorded purchase price: ${purchasePrice} SOL per token.`);

  // Step 5: Prepare sell transactions.
  const sellTxs: VersionedTransaction[] = [];
  const latestBlockhashResponse2 = await getLatestBlockhashWithRetry();
  const { blockhash: sellBlockhash } = latestBlockhashResponse2;
  for (const buyer of buyerKeypairs) {
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
    const swapIx = createDevnetSwapInstructionForSell({
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

  // Step 6: Monitor for sell trigger.
  console.log(
    "Monitoring for sell condition: a 10% price drop from purchase or type 'sell' to trigger immediately."
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
      "Type 'sell' to trigger sell immediately, or press Enter to continue monitoring: "
    );
    if (command.trim().toLowerCase() === "sell") {
      console.log("User triggered immediate sell.");
      shouldSell = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Step 7: Send sell transactions.
  console.log("Sending devnet live sell transactions...");
  await sendBundle(sellTxs);
  console.log("Devnet live sell transactions sent successfully!");

  // Step 8: Optionally, reclaim leftover SOL from buyer wallets.
  const reclaimChoice = prompt(
    "Do you want to reclaim leftover SOL from buyer wallets? (y/n): "
  );
  if (reclaimChoice.trim().toLowerCase() === "y") {
    const { reclaimBuyersSol } = await import("./reclaim");
    await reclaimBuyersSol();
  }
}
