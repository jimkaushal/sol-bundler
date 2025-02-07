import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  TransactionMessage,
  Blockhash,
} from "@solana/web3.js";
import { loadKeypairs } from "./createKeys";
import {
  wallet,
  connection,
  payer,
  getAddressLookupTableWithRetry,
} from "../config";
import {
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
} from "@solana/spl-token";
// Import the new live Pump.fun functions
import { liveBuyPumpFun, liveSellPumpFun } from "./livePumpFun";
import { searcherClient } from "./clients/jito";
import { Bundle as JitoBundle } from "jito-ts/dist/sdk/block-engine/types.js";
import promptSync from "prompt-sync";
import { createLUT, extendLUT } from "./createLUT";
import fs from "fs";
import path from "path";
import { getRandomTipAccount } from "./clients/config";
import BN from "bn.js";
import { liveBuyAndSellPumpFun } from "./livePumpFunSnipe";

const prompt = promptSync();
const keyInfoPath = path.join(__dirname, "keyInfo.json");

let poolInfo: { [key: string]: any } = {};
if (fs.existsSync(keyInfoPath)) {
  const data = fs.readFileSync(keyInfoPath, "utf-8");
  poolInfo = JSON.parse(data);
}
interface Buy {
  pubkey: PublicKey;
  solAmount: Number;
  tokenAmount: BN;
  percentSupply: number;
}

async function generateSOLTransferForKeypairs(
  tipAmt: number,
  steps: number = 24
): Promise<TransactionInstruction[]> {
  const keypairs: Keypair[] = loadKeypairs();
  const ixs: TransactionInstruction[] = [];

  let existingData: any = {};
  if (fs.existsSync(keyInfoPath)) {
    existingData = JSON.parse(fs.readFileSync(keyInfoPath, "utf-8"));
  }

  // Dev wallet send first
  if (
    !existingData[wallet.publicKey.toString()] ||
    !existingData[wallet.publicKey.toString()].solAmount
  ) {
    console.log(`Missing solAmount for dev wallet, skipping.`);
  }
  console.log({ existingWallet: existingData[wallet.publicKey.toString()] });
  const solAmount = parseFloat(
    existingData[wallet.publicKey.toString()].solAmount
  );

  ixs.push(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: wallet.publicKey,
      lamports: Math.floor((solAmount * 1.015 + 0.0025) * LAMPORTS_PER_SOL),
    })
  );

  // Loop through the keypairs and process each one
  for (let i = 0; i < Math.min(steps, keypairs.length); i++) {
    const keypair = keypairs[i];
    const keypairPubkeyStr = keypair.publicKey.toString();

    if (
      !existingData[keypairPubkeyStr] ||
      !existingData[keypairPubkeyStr].solAmount
    ) {
      console.log(`Missing solAmount for wallet ${i + 1}, skipping.`);
      continue;
    }

    const solAmount = parseFloat(existingData[keypairPubkeyStr].solAmount);

    try {
      ixs.push(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: keypair.publicKey,
          lamports: Math.floor((solAmount * 1.015 + 0.0025) * LAMPORTS_PER_SOL),
        })
      );
      console.log(
        `Sent ${(solAmount * 1.015 + 0.0025).toFixed(3)} SOL to Wallet ${
          i + 1
        } (${keypair.publicKey.toString()})`
      );
    } catch (error) {
      console.error(
        `Error creating transfer instruction for wallet ${i + 1}:`,
        error
      );
      continue;
    }
  }

  ixs.push(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: getRandomTipAccount(),
      lamports: BigInt(tipAmt),
    })
  );

  return ixs;
}

function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

async function createAndSignVersionedTxWithKeypairs(
  instructionsChunk: TransactionInstruction[],
  blockhash: Blockhash | string,
  extraSigners: Keypair[] = []
): Promise<VersionedTransaction | null> {
  if (instructionsChunk.length === 0) {
    console.log("Skipping empty transaction batch.");
    return null;
  }

  let lookupTableAccount = null;
  if (poolInfo.addressLUT) {
    const lut = new PublicKey(poolInfo.addressLUT.toString());
    lookupTableAccount = await getLUTWithRetry(lut);
    if (!lookupTableAccount) {
      console.log(
        "Warning: Lookup table account not found, continuing without LUT."
      );
    }
  }

  console.log("Creating transaction with instructions:", instructionsChunk);

  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: instructionsChunk,
  }).compileToV0Message(lookupTableAccount ? [lookupTableAccount] : []);

  const versionedTx = new VersionedTransaction(message);
  // Sign with both the payer and any extra signers (i.e. buyer wallets)
  versionedTx.sign([payer, ...extraSigners]);

  // Optionally simulate before returning
  try {
    const simulationResult = await connection.simulateTransaction(versionedTx);
    if (simulationResult.value.err) {
      console.error(
        "Transaction simulation failed:",
        simulationResult.value.err
      );
      return null;
    }
  } catch (err) {
    console.error("Simulation error:", err);
    return null;
  }

  return versionedTx;
}

async function processInstructionsSOL(
  ixs: TransactionInstruction[],
  blockhash: string | Blockhash
): Promise<VersionedTransaction[]> {
  const txns: VersionedTransaction[] = [];
  const instructionChunks = chunkArray(ixs, 20);

  for (const chunk of instructionChunks) {
    const versionedTx = await createAndSignVersionedTxWithKeypairs(
      chunk,
      blockhash
    );
    if (versionedTx) {
      txns.push(versionedTx);
    }
  }

  return txns;
}

async function sendBundle(txns: VersionedTransaction[]) {
  try {
    const bundleId = await searcherClient.sendBundle(
      new JitoBundle(txns, txns.length)
    );
    console.log(`Bundle ${bundleId} sent.`);
  } catch (error) {
    console.error("Error sending bundle:", error);
  }
}

async function getLatestBlockhashWithRetry(retries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const blockhashResponse = await connection.getLatestBlockhash();
      return blockhashResponse;
    } catch (err) {
      console.warn(`Attempt ${attempt} to fetch blockhash failed: ${err}`);
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } else {
        throw new Error(
          `Failed to fetch blockhash after ${retries} attempts: ${err}`
        );
      }
    }
  }
  // Fallback, should never reach here.
  throw new Error("Unexpected error in getLatestBlockhashWithRetry");
}

async function generateATAandSOL() {
  const jitoTipAmt = +prompt("Jito tip in Sol (Ex. 0.01): ") * LAMPORTS_PER_SOL;
  const { blockhash } = await getLatestBlockhashWithRetry();
  const sendTxns: VersionedTransaction[] = [];

  const solIxs = await generateSOLTransferForKeypairs(jitoTipAmt);
  const solTxns = await processInstructionsSOL(solIxs, blockhash);
  sendTxns.push(...solTxns);

  console.log("Sending SOL bundle...", solTxns.length, "txns");
  await sendBundle(sendTxns);
}

/** Helper to delete all keypair files in src/keypairs */
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

async function getLUTWithRetry(
  lutPublicKey: PublicKey,
  retries = 3,
  delayMs = 1000
) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await getAddressLookupTableWithRetry(lutPublicKey);
      if (response) return response;
    } catch (err) {
      console.warn(`Attempt ${attempt} failed: ${err}`);
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } else {
        throw err;
      }
    }
  }
  return null;
}

/**
 * Clears buyer simulation data from src/keyInfo.json while preserving reserved keys:
 * addressLUT, mint, and mintPk.
 */
function clearKeyInfo() {
  // Build the path relative to the project root.
  const keyInfoPath = path.join(process.cwd(), "src", "keyInfo.json");
  console.log(`Attempting to clear keyInfo.json at: ${keyInfoPath}`);

  if (fs.existsSync(keyInfoPath)) {
    try {
      // Read the existing file, if it exists.
      const rawData = fs.readFileSync(keyInfoPath, "utf8");
      let data: { [key: string]: any } = {};
      try {
        data = JSON.parse(rawData);
      } catch (parseErr) {
        console.error(
          "Error parsing keyInfo.json. Overwriting with an empty object."
        );
      }

      // Preserve reserved keys: addressLUT, mint, mintPk
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

      // Write the preserved data back to keyInfo.json.
      fs.writeFileSync(keyInfoPath, JSON.stringify(preserved, null, 2), "utf8");
      console.log(
        "Cleared buyer simulation data from keyInfo.json while preserving LUT and mint info."
      );
    } catch (err) {
      console.error("Error clearing keyInfo.json:", err);
    }
  } else {
    console.log("keyInfo.json does not exist at", keyInfoPath);
  }
}

async function createReturns() {
  const txsSigned: VersionedTransaction[] = [];
  const keypairs = loadKeypairs();
  const chunkedKeypairs = chunkArray(keypairs, 7); // assuming chunkArray is defined elsewhere

  const jitoTipIn = prompt("Jito tip in Sol (Ex. 0.01): ");
  const TipAmt = parseFloat(jitoTipIn) * LAMPORTS_PER_SOL;

  // Use the retry helper to fetch the blockhash
  let blockhashResponse;
  try {
    blockhashResponse = await getLatestBlockhashWithRetry();
  } catch (err) {
    console.error("Failed to fetch blockhash after retries:", err);
    return;
  }
  const { blockhash } = blockhashResponse;

  // Process each chunk of keypairs
  for (const chunk of chunkedKeypairs) {
    const instructionsForChunk = [];
    const extraSigners: Keypair[] = [];

    for (const keypair of chunk) {
      console.log(`Processing keypair: ${keypair.publicKey.toString()}`);
      let balance = 0;
      let retryCount = 0;
      let success = false;

      while (retryCount < 10 && !success) {
        try {
          balance = await connection.getBalance(keypair.publicKey);
          success = true;
        } catch (error) {
          console.warn(
            `Rate limited (429), retrying in ${500 * 2 ** retryCount}ms...`
          );
          await new Promise((resolve) =>
            setTimeout(resolve, 500 * 2 ** retryCount)
          );
          retryCount++;
        }
      }

      if (!success) {
        console.error(
          `Failed to fetch balance for ${keypair.publicKey.toString()} after retries.`
        );
        continue;
      }

      // Skip wallets with negligible balance (here defined as <= 10000 lamports)
      if (balance <= 10000) {
        console.log(
          `Skipping keypair ${keypair.publicKey.toString()} because it has no SOL.`
        );
        continue;
      }

      console.log(
        `Transferring ${
          balance / LAMPORTS_PER_SOL
        } SOL from ${keypair.publicKey.toString()}`
      );

      // Create a transfer instruction from the buyer wallet to the main wallet
      instructionsForChunk.push(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: payer.publicKey,
          lamports: balance,
        })
      );

      extraSigners.push(keypair);
    }

    // If there are instructions for this chunk, add the Jito tip and create a transaction
    if (instructionsForChunk.length > 0) {
      instructionsForChunk.push(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: getRandomTipAccount(), // ensure getRandomTipAccount() is defined
          lamports: BigInt(TipAmt),
        })
      );
      const versionedTx = await createAndSignVersionedTxWithKeypairs(
        instructionsForChunk,
        blockhash,
        extraSigners
      );
      if (versionedTx) txsSigned.push(versionedTx);
    }
  }

  // If no transactions were created, log and cleanup before returning
  if (txsSigned.length === 0) {
    console.log("No valid transactions, skipping bundle send.");
    // Call cleanup functions even if no transactions exist
    deleteAllKeypairFiles();
    clearKeyInfo();
    return;
  }

  // Otherwise, send the bundle and then perform cleanup
  await sendBundle(txsSigned);

  // After sending, clean up local keypair files and keyInfo.json
  deleteAllKeypairFiles();
  clearKeyInfo();
  console.log(
    "✅ All buyer keypairs have been deleted and simulation data cleared. New wallets can now be generated."
  );
}

async function simulateAndWriteBuys() {
  const keypairs = loadKeypairs();

  const tokenDecimals = 10 ** 6;
  const tokenTotalSupply = 1000000000 * tokenDecimals;
  let initialRealSolReserves = 0;
  let initialVirtualTokenReserves = 1073000000 * tokenDecimals;
  let initialRealTokenReserves = 793100000 * tokenDecimals;
  let totalTokensBought = 0;
  const buys: {
    pubkey: PublicKey;
    solAmount: Number;
    tokenAmount: BN;
    percentSupply: number;
  }[] = [];

  for (let it = 0; it <= 24; it++) {
    let keypair;

    let solInput;
    if (it === 0) {
      solInput = prompt(`Enter the amount of SOL for dev wallet: `);
      solInput = Number(solInput) * 1.21;
      keypair = wallet;
    } else {
      solInput = +prompt(`Enter the amount of SOL for wallet ${it}: `);
      keypair = keypairs[it - 1];
    }

    const solAmount = solInput * LAMPORTS_PER_SOL;

    if (isNaN(solAmount) || solAmount <= 0) {
      console.log(`Invalid input for wallet ${it}, skipping.`);
      continue;
    }

    const e = new BN(solAmount);
    const initialVirtualSolReserves =
      30 * LAMPORTS_PER_SOL + initialRealSolReserves;
    const a = new BN(initialVirtualSolReserves).mul(
      new BN(initialVirtualTokenReserves)
    );
    const i = new BN(initialVirtualSolReserves).add(e);
    const l = a.div(i).add(new BN(1));
    let tokensToBuy = new BN(initialVirtualTokenReserves).sub(l);
    tokensToBuy = BN.min(tokensToBuy, new BN(initialRealTokenReserves));

    const tokensBought = tokensToBuy.toNumber();
    const percentSupply = (tokensBought / tokenTotalSupply) * 100;

    console.log(
      `Wallet ${it}: Bought ${tokensBought / tokenDecimals} tokens for ${
        e.toNumber() / LAMPORTS_PER_SOL
      } SOL`
    );
    console.log(
      `Wallet ${it}: Owns ${percentSupply.toFixed(4)}% of total supply\n`
    );

    buys.push({
      pubkey: keypair.publicKey,
      solAmount: Number(solInput),
      tokenAmount: tokensToBuy,
      percentSupply,
    });

    initialRealSolReserves += e.toNumber();
    initialRealTokenReserves -= tokensBought;
    initialVirtualTokenReserves -= tokensBought;
    totalTokensBought += tokensBought;
  }

  console.log(
    "Final real sol reserves: ",
    initialRealSolReserves / LAMPORTS_PER_SOL
  );
  console.log(
    "Final real token reserves: ",
    initialRealTokenReserves / tokenDecimals
  );
  console.log(
    "Final virtual token reserves: ",
    initialVirtualTokenReserves / tokenDecimals
  );
  console.log("Total tokens bought: ", totalTokensBought / tokenDecimals);
  console.log(
    "Total % of tokens bought: ",
    (totalTokensBought / tokenTotalSupply) * 100
  );
  console.log(); // \n

  const confirm = prompt(
    "Do you want to use these buys? (yes/no): "
  ).toLowerCase();
  if (confirm === "yes") {
    writeBuysToFile(buys);
  } else {
    console.log("Simulation aborted. Restarting...");
    simulateAndWriteBuys(); // Restart the simulation
  }
}

function writeBuysToFile(buys: Buy[]) {
  let existingData: any = {};

  if (fs.existsSync(keyInfoPath)) {
    existingData = JSON.parse(fs.readFileSync(keyInfoPath, "utf-8"));
  }

  // Convert buys array to an object keyed by public key
  const buysObj = buys.reduce((acc, buy) => {
    acc[buy.pubkey.toString()] = {
      solAmount: buy.solAmount.toString(),
      tokenAmount: buy.tokenAmount.toString(),
      percentSupply: buy.percentSupply,
    };
    return acc;
  }, existingData); // Initialize with existing data

  // Write updated data to file
  fs.writeFileSync(keyInfoPath, JSON.stringify(buysObj, null, 2), "utf8");
  console.log("Buys have been successfully saved to keyinfo.json");
}
export async function sender() {
  let running = true;

  while (running) {
    console.log("\nBuyer UI:");
    console.log("1. Create LUT");
    console.log("2. Extend LUT Bundle");
    console.log("3. Simulate Buys");
    console.log("4. Send Simulation SOL Bundle");
    console.log("5. Reclaim Buyers Sol");
    console.log("6. Live Pump.fun Buy");
    console.log("7. Live Pump.fun Sell");
    const answer = prompt("Choose an option or 'exit': ");

    switch (answer) {
      case "1":
        await createLUT();
        break;
      case "2":
        await extendLUT();
        break;
      case "3":
        await simulateAndWriteBuys();
        break;
      case "4":
        await generateATAandSOL();
        break;
      case "5":
        await createReturns();
        break;
      case "6":
        // New: Live Pump.fun Buy
        await liveBuyPumpFun();
        break;
      case "7":
        // New: Live Pump.fun Sell
        await liveSellPumpFun();
        break;
      case "8":
        await liveBuyAndSellPumpFun();
        break;
      case "exit":
        running = false;
        break;
      default:
        console.log("Invalid option, please choose again.");
    }
  }
  console.log("Exiting...");
}
