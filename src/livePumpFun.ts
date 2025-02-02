import {
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { connection, payer } from "../config";
import promptSync from "prompt-sync";
import { loadKeypairs } from "./createKeys";
import { getMint, Mint } from "@solana/spl-token";
import { getLatestBlockhashWithRetry } from "./retryHelpers";
import { sendBundle } from "./bundleSender";

const prompt = promptSync();

/**
 * Fetch on-chain mint info for the given token contract address.
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
 * Placeholder: Create a swap instruction for buying tokens via Pump.fun.
 * Replace this with the actual Pump.fun swap instruction construction.
 */
export function createPumpFunSwapInstructionForBuy(params: {
  buyerPubkey: PublicKey;
  tokenMint: PublicKey;
  solAmount: number;
}): TransactionInstruction {
  const { buyerPubkey, tokenMint, solAmount } = params;
  const instructionData = Buffer.alloc(0); // Placeholder data
  return new TransactionInstruction({
    keys: [
      { pubkey: buyerPubkey, isSigner: true, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
    ],
    programId: new PublicKey("PumPFun1111111111111111111111111111111111"), // Placeholder Pump.fun program ID
    data: instructionData,
  });
}

/**
 * Placeholder: Create a swap instruction for selling tokens via Pump.fun.
 * Replace this with the actual Pump.fun swap instruction construction.
 */
export function createPumpFunSwapInstructionForSell(params: {
  buyerPubkey: PublicKey;
  tokenMint: PublicKey;
  tokenAmount: number;
}): TransactionInstruction {
  const { buyerPubkey, tokenMint, tokenAmount } = params;
  const instructionData = Buffer.alloc(0); // Placeholder data
  return new TransactionInstruction({
    keys: [
      { pubkey: buyerPubkey, isSigner: true, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
    ],
    programId: new PublicKey("PumPFun1111111111111111111111111111111111"), // Placeholder Pump.fun program ID
    data: instructionData,
  });
}

/**
 * Live Pump.fun Buy:
 * Prompts for the token contract address, fetches its mint info,
 * and uses the 24 buyer wallets to swap SOL for tokens.
 */
export async function liveBuyPumpFun() {
  const tokenAddressInput = prompt("Enter the token contract address: ");
  let tokenMint: PublicKey;
  try {
    tokenMint = new PublicKey(tokenAddressInput.trim());
  } catch (err) {
    console.error("Invalid token address");
    return;
  }

  const mintInfo = await getTokenMintInfo(tokenAddressInput);
  console.log("Token mint info fetched:", mintInfo);

  const buyerKeypairs = loadKeypairs();
  const txs: VersionedTransaction[] = [];
  const { blockhash } = await getLatestBlockhashWithRetry();

  for (const buyer of buyerKeypairs) {
    const balance = await connection.getBalance(buyer.publicKey);
    if (balance < 10000) {
      console.log(
        `Skipping wallet ${buyer.publicKey.toString()} due to insufficient SOL.`
      );
      continue;
    }
    // Use almost all available SOL (keeping 10,000 lamports for fees)
    const solToSpend = balance - 10000;
    const swapIx = createPumpFunSwapInstructionForBuy({
      buyerPubkey: buyer.publicKey,
      tokenMint,
      solAmount: solToSpend,
    });

    const message = new TransactionMessage({
      payerKey: buyer.publicKey,
      recentBlockhash: blockhash,
      instructions: [swapIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([buyer]);
    txs.push(tx);
  }

  if (txs.length === 0) {
    console.error("No valid buy transactions to send.");
    return;
  }
  await sendBundle(txs);
  console.log("Live buy transactions on Pump.fun sent successfully!");
}

/**
 * Live Pump.fun Sell:
 * Prompts for the token contract address, fetches its mint info,
 * and uses the 24 buyer wallets to swap tokens for SOL.
 */
export async function liveSellPumpFun() {
  const tokenAddressInput = prompt("Enter the token contract address: ");
  let tokenMint: PublicKey;
  try {
    tokenMint = new PublicKey(tokenAddressInput.trim());
  } catch (err) {
    console.error("Invalid token address");
    return;
  }

  const mintInfo = await getTokenMintInfo(tokenAddressInput);
  console.log("Token mint info fetched:", mintInfo);

  // Here, you should implement a function to fetch each buyer wallet's token balance.
  // For this placeholder, we assume every wallet holds some tokens.
  const buyerKeypairs = loadKeypairs();
  const txs: VersionedTransaction[] = [];
  const { blockhash } = await getLatestBlockhashWithRetry();

  for (const buyer of buyerKeypairs) {
    // Placeholder: In a real implementation, get the actual token balance for the buyer.
    const tokenBalance = 1000; // Dummy value; replace with actual balance retrieval
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
      recentBlockhash: blockhash,
      instructions: [swapIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([buyer]);
    txs.push(tx);
  }

  if (txs.length === 0) {
    console.error("No valid sell transactions to send.");
    return;
  }
  await sendBundle(txs);
  console.log("Live sell transactions on Pump.fun sent successfully!");
}
