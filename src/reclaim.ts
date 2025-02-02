import {
  SystemProgram,
  VersionedTransaction,
  TransactionMessage,
  PublicKey,
} from "@solana/web3.js";
import fs from "fs";
import path from "path";
import promptSync from "prompt-sync";
import { connection, payer } from "../config";
import { loadKeypairs } from "./createKeys";
import { sendBundle } from "./bundleSender";
import { getLatestBlockhashWithRetry } from "./retryHelpers";

const prompt = promptSync();
const KEY_INFO_PATH = path.join(process.cwd(), "src", "keyInfo.json");

/**
 * Reclaims leftover SOL from buyer wallets back to the main (payer) wallet.
 * It creates and sends transactions from each buyer wallet that has a non‐zero SOL balance.
 * After sending the transactions, it deletes all buyer keypair files and clears simulation data.
 */
async function reclaimBuyersSol() {
  const buyerKeypairs = loadKeypairs();
  const txs: VersionedTransaction[] = [];

  // Get a recent blockhash using retry logic.
  let blockhashResponse;
  try {
    blockhashResponse = await getLatestBlockhashWithRetry();
  } catch (err) {
    console.error("Failed to fetch blockhash for reclaim transactions:", err);
    return;
  }
  const { blockhash } = blockhashResponse;

  // For each buyer wallet, create a transaction to transfer all SOL (minus a small fee reserve) back to the main wallet.
  for (const buyer of buyerKeypairs) {
    let balance: number;
    try {
      balance = await connection.getBalance(buyer.publicKey);
    } catch (err) {
      console.error(
        `Error fetching balance for ${buyer.publicKey.toString()}:`,
        err
      );
      continue;
    }
    // Skip if the balance is too low (i.e. already near zero)
    if (balance <= 10000) {
      console.log(
        `Skipping wallet ${buyer.publicKey.toString()} due to insufficient SOL.`
      );
      continue;
    }
    // Transfer nearly all funds, keeping 10,000 lamports for fees.
    const transferAmount = balance - 10000;
    const transferIx = SystemProgram.transfer({
      fromPubkey: buyer.publicKey,
      toPubkey: payer.publicKey,
      lamports: transferAmount,
    });
    const message = new TransactionMessage({
      payerKey: buyer.publicKey,
      recentBlockhash: blockhash,
      instructions: [transferIx],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([buyer]);
    txs.push(tx);
  }

  if (txs.length === 0) {
    console.log("No valid reclaim transactions to send.");
  } else {
    await sendBundle(txs);
    console.log("Reclaim transactions sent successfully!");
  }

  // Cleanup: Delete buyer keypair files and clear simulation data.
  deleteAllKeypairFiles();
  clearKeyInfo();
}

/**
 * Deletes all keypair JSON files in the src/keypairs folder.
 */
function deleteAllKeypairFiles() {
  const keysFolderPath = path.join(process.cwd(), "src", "keypairs");
  console.log(`Attempting to delete keypair files in: ${keysFolderPath}`);
  if (fs.existsSync(keysFolderPath)) {
    const files = fs.readdirSync(keysFolderPath);
    if (files.length === 0) {
      console.log("No keypair files found to delete.");
    }
    files.forEach((file) => {
      const filePath = path.join(keysFolderPath, file);
      try {
        fs.unlinkSync(filePath);
        console.log(`Deleted keypair file: ${filePath}`);
      } catch (err) {
        console.error(`Error deleting file ${filePath}:`, err);
      }
    });
  } else {
    console.log(`Keypairs folder does not exist at ${keysFolderPath}`);
  }
}

/**
 * Clears buyer simulation data from src/keyInfo.json while preserving reserved keys:
 * addressLUT, mint, and mintPk.
 */
function clearKeyInfo() {
  const keyInfoFilePath = KEY_INFO_PATH;
  console.log(`Attempting to clear keyInfo.json at: ${keyInfoFilePath}`);
  if (fs.existsSync(keyInfoFilePath)) {
    try {
      const rawData = fs.readFileSync(keyInfoFilePath, "utf8");
      let data: { [key: string]: any } = {};
      try {
        data = JSON.parse(rawData);
      } catch (parseErr) {
        console.error(
          "Error parsing keyInfo.json. Overwriting with an empty object."
        );
      }
      // Preserve reserved keys.
      const preserved: { [key: string]: any } = {};
      if (data.addressLUT) {
        preserved.addressLUT = data.addressLUT;
      }
      if (data.mint) {
        preserved.mint = data.mint;
      }
      if (data.mintPk) {
        preserved.mintPk = data.mintPk;
      }
      fs.writeFileSync(
        keyInfoFilePath,
        JSON.stringify(preserved, null, 2),
        "utf8"
      );
      console.log(
        "Cleared buyer simulation data from keyInfo.json while preserving LUT and mint info."
      );
    } catch (err) {
      console.error("Error clearing keyInfo.json:", err);
    }
  } else {
    console.log("keyInfo.json does not exist at", keyInfoFilePath);
  }
}

/**
 * If you want to export this function for use in your UI/menu, uncomment the following line:
 */
export { reclaimBuyersSol };
