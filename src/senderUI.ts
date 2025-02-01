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
import { wallet, connection, payer } from "../config";
import {
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import { searcherClient } from "./clients/jito";
import { Bundle as JitoBundle } from "jito-ts/dist/sdk/block-engine/types.js";
import promptSync from "prompt-sync";
import { createLUT, extendLUT } from "./createLUT";
import fs from "fs";
import path from "path";
import { getRandomTipAccount } from "./clients/config";
import BN from "bn.js";

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
    lookupTableAccount = (await connection.getAddressLookupTable(lut)).value;
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

async function generateATAandSOL() {
  const jitoTipAmt = +prompt("Jito tip in Sol (Ex. 0.01): ") * LAMPORTS_PER_SOL;
  const { blockhash } = await connection.getLatestBlockhash();
  const sendTxns: VersionedTransaction[] = [];

  const solIxs = await generateSOLTransferForKeypairs(jitoTipAmt);
  const solTxns = await processInstructionsSOL(solIxs, blockhash);
  sendTxns.push(...solTxns);

  console.log("Sending SOL bundle...", solTxns.length, "txns");
  await sendBundle(sendTxns);
}

async function createReturns() {
  const txsSigned: VersionedTransaction[] = [];
  const keypairs = loadKeypairs();
  const chunkedKeypairs = chunkArray(keypairs, 7);

  const jitoTipIn = prompt("Jito tip in Sol (Ex. 0.01): ");
  const TipAmt = parseFloat(jitoTipIn) * LAMPORTS_PER_SOL;

  const { blockhash } = await connection.getLatestBlockhash();

  for (const chunk of chunkedKeypairs) {
    const instructionsForChunk: TransactionInstruction[] = [];
    const extraSigners: Keypair[] = []; // Collect buyer wallets that are spending funds

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

      if (balance === 0) {
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

      // Transfer the ENTIRE balance from the buyer wallet to the main wallet.
      instructionsForChunk.push(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: payer.publicKey,
          lamports: balance,
        })
      );

      // Mark this buyer wallet as an extra signer
      extraSigners.push(keypair);
    }

    if (instructionsForChunk.length === 0) {
      console.log("Skipping empty transaction batch.");
      continue;
    }

    // Add the Jito tip transfer (this is from the main wallet so no extra signer is needed)
    instructionsForChunk.push(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: getRandomTipAccount(),
        lamports: BigInt(TipAmt),
      })
    );

    console.log("Jito tip added.");

    // Create and sign the transaction with both the payer and the buyer wallets
    const versionedTx = await createAndSignVersionedTxWithKeypairs(
      instructionsForChunk,
      blockhash,
      extraSigners
    );
    if (versionedTx) txsSigned.push(versionedTx);
  }

  if (txsSigned.length === 0) {
    console.log("No valid transactions, skipping bundle send.");
    return;
  }

  await sendBundle(txsSigned);

  // Delete local keypair files to force creation of fresh wallets next time
  console.log("Deleting old keypair files to ensure fresh wallets...");
  for (const keypair of keypairs) {
    const filePath = path.join(
      __dirname,
      "..",
      "keys",
      `${keypair.publicKey.toString()}.json`
    );
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`Deleted keypair file: ${filePath}`);
    }
  }

  console.log(
    "✅ All buyer accounts drained and local keypair files deleted. New wallets can now be generated."
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
      case "exit":
        running = false;
        break;
      default:
        console.log("Invalid option, please choose again.");
    }
  }
  console.log("Exiting...");
}
