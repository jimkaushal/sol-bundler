import { VersionedTransaction } from "@solana/web3.js";
import { connection } from "../config";
// Import the Jito client and bundle type from the jito-ts SDK.
import { searcherClient } from "./clients/jito";
import { Bundle as JitoBundle } from "jito-ts/dist/sdk/block-engine/types.js";

/**
 * Sends a bundle of VersionedTransaction objects.
 *
 * For ultra‑low latency, we first attempt to send the bundle via Jito’s specialized bundler API.
 * If that fails, we fall back to sending transactions individually using connection.sendRawTransaction.
 *
 * @param txs An array of VersionedTransaction objects to be sent.
 */
export async function sendBundle(txs: VersionedTransaction[]): Promise<void> {
  try {
    // Create a Jito bundle from your transactions.
    const bundle = new JitoBundle(txs, txs.length);
    const bundleId = await searcherClient.sendBundle(bundle);
    console.log("Bundle sent via Jito with id:", bundleId);
  } catch (err) {
    console.error("Error sending bundle via Jito:", err);
    console.log("Falling back to individual transaction submission...");
    // Fallback: Send transactions one-by-one.
    for (const tx of txs) {
      try {
        const rawTx = tx.serialize();
        const txid = await connection.sendRawTransaction(rawTx);
        console.log("Fallback: Transaction sent with txid:", txid);
        // Optionally wait for confirmation.
        await connection.confirmTransaction(txid);
      } catch (fallbackErr) {
        console.error("Fallback error sending transaction:", fallbackErr);
      }
    }
  }
}
