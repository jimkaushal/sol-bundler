// createLUT.ts
import {
  AddressLookupTableProgram,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Blockhash,
  AddressLookupTableAccount,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import fs from "fs";
import path from "path";
import {
  wallet,
  connection,
  PUMP_PROGRAM,
  payer,
  feeRecipient,
  eventAuthority,
  getAddressLookupTableWithRetry,
  rpc,
  global as GLOBAL,
} from "../config";
import promptSync from "prompt-sync";
import { searcherClient } from "./clients/jito";
import { Bundle as JitoBundle } from "jito-ts/dist/sdk/block-engine/types.js";
import { getRandomTipAccount } from "./clients/config";
import { lookupTableProvider } from "./clients/LookupTableProvider";
import { loadKeypairs } from "./createKeys";
import * as spl from "@solana/spl-token";
import idl from "../pumpfun-IDL.json";
import { Program, Idl, AnchorProvider, setProvider } from "@coral-xyz/anchor";
import { bs58 } from "@project-serum/anchor/dist/cjs/utils/bytes";
import BN from "bn.js";

const prompt = promptSync();
const keyInfoPath = path.join(__dirname, "keyInfo.json");

// Set up Anchor provider and program
const provider = new AnchorProvider(connection, wallet as any, {});
setProvider(provider);
const program = new Program(idl as Idl, PUMP_PROGRAM);

/**
 * Fetches a fresh blockhash before sending a transaction.
 */
async function getFreshBlockhash() {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();
  return { blockhash, lastValidBlockHeight };
}

/**
 * Sends a transaction with retries and a fresh blockhash.
 */
// async function sendTransactionWithRetry(tx: VersionedTransaction) {
//   const { blockhash } = await getFreshBlockhash();
//   tx.message.recentBlockhash = blockhash;
//   try {
//     return await connection.sendTransaction(tx, { maxRetries: 10 });
//   } catch (error) {
//     console.error("Error sending transaction:", error);
//   }
// }

/**
 * Create a proper SPL token mint.
 * Generates a new Keypair for the mint and then calls spl.createMint()
 * to initialize the mint with 6 decimals, wallet as mint authority, and no freeze authority.
 * Returns the mint Keypair.
 */
async function createProperMint(): Promise<Keypair> {
  const decimals = 6;
  const mintAuthority = wallet.publicKey;
  const freezeAuthority = null;
  const mintKp = Keypair.generate();
  const newMintPubkey = await spl.createMint(
    connection, // Cluster connection
    payer, // Payer for fees
    mintAuthority, // Mint authority
    freezeAuthority,
    decimals,
    mintKp // Use the generated keypair
  );
  console.log("New SPL Token mint created:", newMintPubkey.toBase58());
  return mintKp;
}

/**
 * Helper: Chunk an array into subarrays of a given size.
 */
function chunkArray<T>(array: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(array.length / size) }, (_, i) =>
    array.slice(i * size, i * size + size)
  );
}

/**
 * Create wallet swap transactions (simulate buys).
 * For each buyer keypair, derive the associated token account and build the "buy" instruction.
 */
async function createWalletSwaps(
  blockhash: string,
  keypairs: Keypair[],
  lut: AddressLookupTableAccount,
  mint: PublicKey,
  program: Program
): Promise<VersionedTransaction[]> {
  const txsSigned: VersionedTransaction[] = [];
  const chunkedKeypairs = chunkArray(keypairs, 6);

  // Derive bondingCurve and associatedBondingCurve PDAs from the mint.
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBytes()],
    program.programId
  );
  const [associatedBondingCurve] = PublicKey.findProgramAddressSync(
    [bondingCurve.toBytes(), spl.TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
    spl.ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // *** DERIVE THE GLOBAL PDA ***
  // IMPORTANT: Derive the global PDA using the same seed that your program uses.
  const [globalPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("global")],
    PUMP_PROGRAM
  );
  console.log("Derived global PDA:", globalPDA.toBase58());

  // Load key info from keyInfo.json
  let keyInfo: {
    [pubkey: string]: {
      solAmount: number;
      tokenAmount: string;
      percentSupply: number;
    };
  } = {};
  if (fs.existsSync(keyInfoPath)) {
    try {
      keyInfo = JSON.parse(fs.readFileSync(keyInfoPath, "utf-8"));
    } catch (e) {
      console.error("Error parsing keyInfo.json:", e);
    }
  }

  for (let chunkIndex = 0; chunkIndex < chunkedKeypairs.length; chunkIndex++) {
    const chunk = chunkedKeypairs[chunkIndex];
    const instructionsForChunk: TransactionInstruction[] = [];

    for (let i = 0; i < chunk.length; i++) {
      const buyer = chunk[i];
      const buyerPubkeyStr = buyer.publicKey.toString();
      console.log(
        `Processing keypair ${i + 1}/${chunk.length}: ${buyerPubkeyStr}`
      );

      // Derive the buyer's associated token account for the mint.
      const ataToken = await spl.getAssociatedTokenAddress(
        mint,
        buyer.publicKey
      );
      const createTokenAtaIx =
        spl.createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          ataToken,
          buyer.publicKey,
          mint
        );

      // Get buyer's info from keyInfo.json.
      const buyerInfo = keyInfo[buyerPubkeyStr];
      if (!buyerInfo || !buyerInfo.tokenAmount || !buyerInfo.solAmount) {
        console.log(`Incomplete key info for ${buyerPubkeyStr}, skipping.`);
        continue;
      }

      // Calculate amounts using BN.
      const amount = new BN(buyerInfo.tokenAmount);
      const solAmtBN = new BN(100000 * buyerInfo.solAmount * LAMPORTS_PER_SOL);
      console.log("Accounts for buy instruction:", {
        global: globalPDA.toString(),
        feeRecipient: feeRecipient.toString(),
        mint: mint.toString(),
        bondingCurve: bondingCurve.toString(),
        associatedBondingCurve: associatedBondingCurve.toString(),
        associatedUser: ataToken.toString(),
        user: buyer.publicKey.toString(),
        systemProgram: SystemProgram.programId.toString(),
        tokenProgram: spl.TOKEN_PROGRAM_ID.toString(),
        rent: SYSVAR_RENT_PUBKEY.toString(),
        eventAuthority: eventAuthority.toString(),
        program: PUMP_PROGRAM.toString(),
      });
      // Build the buy instruction using all required accounts.
      let buyIx: TransactionInstruction;
      try {
        buyIx = await program.methods
          .buy(amount, solAmtBN)
          .accounts({
            global: globalPDA, // Use the derived PDA here!
            feeRecipient: feeRecipient,
            mint: mint,
            bondingCurve: bondingCurve,
            associatedBondingCurve: associatedBondingCurve,
            associatedUser: ataToken,
            user: buyer.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: spl.TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
            eventAuthority: eventAuthority,
            program: PUMP_PROGRAM,
          })
          .instruction();
      } catch (err) {
        console.error(
          `Error creating buy instruction for1 ${buyerPubkeyStr}:`,
          err
        );
        continue;
      }

      instructionsForChunk.push(createTokenAtaIx, buyIx);
    }

    if (instructionsForChunk.length > 0) {
      const message = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: blockhash,
        instructions: instructionsForChunk,
      }).compileToV0Message([lut]);
      const versionedTx = new VersionedTransaction(message);
      console.log(
        "Signing transaction with chunk signers:",
        chunk.map((kp) => kp.publicKey.toString())
      );
      for (const kp of chunk) {
        if (keyInfo[kp.publicKey.toString()]) {
          versionedTx.sign([kp]);
        }
      }
      versionedTx.sign([payer]);
      txsSigned.push(versionedTx);
    }
  }
  return txsSigned;
}

async function sendTransactionsInBatches(transactions: VersionedTransaction[]) {
  const batchSize = 5; // Maximum transactions per bundle
  for (let i = 0; i < transactions.length; i += batchSize) {
    const batch = transactions.slice(i, i + batchSize);
    try {
      const { blockhash } = await getFreshBlockhash(); // Get fresh blockhash before batch
      for (const tx of batch) {
        let attempts = 0;
        while (attempts < 3) {
          try {
            tx.message.recentBlockhash = blockhash; // Ensure a fresh blockhash
            await connection.sendTransaction(tx, { maxRetries: 10 });
            break; // Exit retry loop if successful
          } catch (error) {
            console.error(
              `Error sending transaction, retrying... (${attempts + 1}/3)`,
              error
            );
            if (
              error instanceof Error &&
              error.message.includes("already been processed")
            ) {
              console.warn("Skipping transaction as it was already processed.");
              break;
            }
            attempts++;
          }
        }
      }
      console.log(
        `Sent batch ${i / batchSize + 1}/${Math.ceil(
          transactions.length / batchSize
        )}`
      );
    } catch (error) {
      console.error(`Error sending batch ${i / batchSize + 1}:`, error);
    }
  }
}

function chunkInstructions(
  instructions: TransactionInstruction[],
  chunkSize: number
): TransactionInstruction[][] {
  return Array.from(
    { length: Math.ceil(instructions.length / chunkSize) },
    (_, i) => instructions.slice(i * chunkSize, i * chunkSize + chunkSize)
  );
}

// The rest of your extendLUT() function remains essentially the same,
// except that in the accounts for the buy instruction you now use the derived globalPDA.
// (Also, in step 4 below, you push GLOBAL (the imported one) into accounts for LUT creation.
// If your program expects the global PDA, you may want to similarly derive it there too.)

/**
 * Updates extendLUT to prevent blockhash expiration.
 */
export async function extendLUT() {
  console.log("Extending Lookup Table...");
  const { blockhash } = await getFreshBlockhash();

  const lut = new PublicKey("E5h4ypaMh1TwGtfRp1SLv6oc9btJLJw17cNxmHKQRCXw");
  const lookupTableAccount = await getAddressLookupTableWithRetry(lut);
  if (!lookupTableAccount) {
    console.error("Lookup table account not found!");
    return;
  }

  const extendInstructions = [
    AddressLookupTableProgram.extendLookupTable({
      lookupTable: lut,
      authority: payer.publicKey,
      payer: payer.publicKey,
      addresses: [wallet.publicKey],
    }),
  ];

  const chunkedInstructions = chunkInstructions(extendInstructions, 2);

  for (const chunk of chunkedInstructions) {
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: chunk,
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([payer]);

    try {
      await sendTransactionsInBatches([tx]);
      console.log("Lookup Table successfully extended.");
    } catch (error) {
      console.error("Error extending Lookup Table:", error);
    }
  }
}

export async function createLUT() {
  const jitoTipAmt = +prompt("Jito tip in Sol (Ex. 0.01): ") * LAMPORTS_PER_SOL;
  let poolInfo: { [key: string]: any } = {};
  if (fs.existsSync(keyInfoPath)) {
    poolInfo = JSON.parse(fs.readFileSync(keyInfoPath, "utf-8"));
  }
  const bundledTxns: VersionedTransaction[] = [];
  const createLUTixs: TransactionInstruction[] = [];

  const [create, lut] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: await connection.getSlot("finalized"),
  });

  createLUTixs.push(
    create,
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: getRandomTipAccount(),
      lamports: jitoTipAmt,
    })
  );

  const addressesMain: PublicKey[] = [];
  createLUTixs.forEach((ixn) => {
    ixn.keys.forEach((key) => {
      addressesMain.push(key.pubkey);
    });
  });

  const lookupTablesMain1 =
    lookupTableProvider.computeIdealLookupTablesForAddresses(addressesMain);
  // const { blockhash } = await connection.getLatestBlockhash();
  const { blockhash } = await getFreshBlockhash();

  const messageMain1 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: createLUTixs,
  }).compileToV0Message(lookupTablesMain1);
  const createLUTTx = new VersionedTransaction(messageMain1);

  poolInfo.addressLUT = lut.toString();
  try {
    const serializedMsg = createLUTTx.serialize();
    console.log("Txn size:", serializedMsg.length);
    if (serializedMsg.length > 1232) {
      console.log("tx too big");
    }
    createLUTTx.sign([payer]);
  } catch (e) {
    console.log(e, "error signing createLUT");
    process.exit(0);
  }
  fs.writeFileSync(keyInfoPath, JSON.stringify(poolInfo, null, 2));
  bundledTxns.push(createLUTTx);
  await sendBundle(bundledTxns);
}

async function buildTxn(
  extendLUTixs: TransactionInstruction[],
  blockhash: string | Blockhash,
  lut: AddressLookupTableAccount
): Promise<VersionedTransaction> {
  const messageMain = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: extendLUTixs,
  }).compileToV0Message([lut]);
  const txn = new VersionedTransaction(messageMain);
  try {
    const serializedMsg = txn.serialize();
    console.log("Txn size:", serializedMsg.length);
    if (serializedMsg.length > 1232) {
      console.log("tx too big");
    }
    txn.sign([payer]);
  } catch (e) {
    console.log("txn size:", txn.serialize().length);
    console.log(e, "error signing extendLUT");
    process.exit(0);
  }
  return txn;
}

async function sendBundle(bundledTxns: VersionedTransaction[]) {
  try {
    const bundleId = await searcherClient.sendBundle(
      new JitoBundle(bundledTxns, bundledTxns.length)
    );
    console.log(`Bundle ${bundleId} sent.`);
    const result = await new Promise((resolve, reject) => {
      searcherClient.onBundleResult(
        (result) => {
          console.log("Received bundle result:", result);
          resolve(result);
        },
        (e: Error) => {
          console.error("Error receiving bundle result:", e);
          reject(e);
        }
      );
    });
    console.log("Result:", result);
  } catch (error) {
    const err = error as any;
    console.error("Error sending bundle:", err.message);
    if (err?.message?.includes("Bundle Dropped, no connected leader up soon")) {
      console.error(
        "Error sending bundle: Bundle Dropped, no connected leader up soon."
      );
    } else {
      console.error("An unexpected error occurred:", err.message);
    }
  }
}
