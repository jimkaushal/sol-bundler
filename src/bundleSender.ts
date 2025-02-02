// src/bundleSender.ts
import { VersionedTransaction } from "@solana/web3.js";
import { connection } from "../config";
import { searcherClient } from "./clients/jito";
import { Bundle as JitoBundle } from "jito-ts/dist/sdk/block-engine/types.js";

/**
 * Splits an array into chunks of the given size.
 * @param array The array to split.
 * @param size Maximum size of each chunk.
 * @returns An array of chunks.
 */
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Sends an array of VersionedTransaction objects using Jito’s bundler API.
 * If the number of transactions exceeds the limit (5 per bundle), the transactions
 * are split into multiple bundles. If sending a bundle via Jito fails, it falls back
 * to sending transactions individually.
 *
 * @param txs An array of VersionedTransaction objects to send.
 */
export async function sendBundle(txs: VersionedTransaction[]): Promise<void> {
  const MAX_BUNDLE_SIZE = 5; // Jito’s maximum transactions per bundle.
  // Split transactions into chunks of size MAX_BUNDLE_SIZE
  const chunks = chunkArray(txs, MAX_BUNDLE_SIZE);

  for (const [index, chunk] of chunks.entries()) {
    try {
      // Create a bundle for the current chunk
      const bundle = new JitoBundle(chunk, chunk.length);
      const bundleId = await searcherClient.sendBundle(bundle);
      console.log(`Bundle ${index} sent via Jito with id:`, bundleId);
    } catch (err) {
      console.error(`Error sending bundle ${index} via Jito:`, err);
      console.log(
        "Falling back to individual transaction submission for this bundle chunk..."
      );
      // Fallback: send transactions one-by-one
      for (const tx of chunk) {
        try {
          const rawTx = tx.serialize();
          const txid = await connection.sendRawTransaction(rawTx);
          console.log("Fallback: Transaction sent with txid:", txid);
          // Optionally wait for confirmation:
          await connection.confirmTransaction(txid);
        } catch (fallbackErr) {
          console.error("Fallback error sending transaction:", fallbackErr);
        }
      }
    }
  }
}
