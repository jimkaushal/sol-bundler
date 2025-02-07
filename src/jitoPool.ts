// jitoPool.ts
import {
  connection,
  wallet,
  PUMP_PROGRAM,
  feeRecipient,
  eventAuthority,
  MPL_TOKEN_METADATA_PROGRAM_ID,
  mintAuthority,
  rpc,
  payer,
  getAddressLookupTableWithRetry,
} from "../config";
import {
  PublicKey,
  VersionedTransaction,
  TransactionInstruction,
  SYSVAR_RENT_PUBKEY,
  TransactionMessage,
  SystemProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import { loadKeypairs } from "./createKeys";
import { searcherClient } from "./clients/jito";
import { Bundle as JitoBundle } from "jito-ts/dist/sdk/block-engine/types.js";
import promptSync from "prompt-sync";
import * as spl from "@solana/spl-token";
import bs58 from "bs58";
import path from "path";
import fs from "fs";
import { Program } from "@coral-xyz/anchor";
import { getRandomTipAccount } from "./clients/config";
import BN from "bn.js";
import axios from "axios";
import * as anchor from "@coral-xyz/anchor";
import registerMetadata from "./registerMetadata";

const prompt = promptSync();
const keyInfoPath = path.join(__dirname, "keyInfo.json");

/**
 * Creates a new SPL token mint.
 * Retries up to maxRetries if the transaction expires.
 * Then polls until the mint account is confirmed as initialized.
 */
async function createProperMint(): Promise<Keypair> {
  const decimals = 6;
  const mintKp = Keypair.generate();
  const maxRetries = 3;
  let newMintPubkey: PublicKey | undefined = undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      newMintPubkey = await spl.createMint(
        connection, // Cluster connection
        payer, // Payer for fees
        wallet.publicKey, // Mint authority
        null, // No freeze authority
        decimals,
        mintKp // The new mint keypair
      );
      console.log("New SPL Token mint created:", newMintPubkey.toBase58());
      break; // Success
    } catch (err: any) {
      if (err.message.includes("already in use")) {
        console.warn(
          `Attempt ${
            attempt + 1
          } failed: Account already in use. Assuming mint creation succeeded.`
        );
        newMintPubkey = mintKp.publicKey;
        break;
      }
      console.warn(
        `Attempt ${attempt + 1} to create mint failed:`,
        err.message
      );
      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } else {
        throw new Error(
          "Mint creation failed after multiple retries: " + err.message
        );
      }
    }
  }

  // Poll until the mint account is confirmed as initialized.
  if (newMintPubkey) {
    let confirmed = false;
    for (let i = 0; i < 10; i++) {
      const mintInfo = await connection.getParsedAccountInfo(newMintPubkey);
      if (mintInfo.value !== null) {
        console.log(
          "Mint account is now initialized. Owner:",
          mintInfo.value.owner.toBase58()
        );
        confirmed = true;
        break;
      }
      console.log("Waiting for mint account to initialize...");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!confirmed) {
      console.error(
        "Mint account was not confirmed as initialized within timeout."
      );
    }
  } else {
    console.error("Failed to create mint: newMintPubkey is undefined");
  }
  return mintKp;
}

/**
 * Creates and confirms a new mint.
 */
async function createAndConfirmMint(): Promise<Keypair> {
  const mintKp = await createProperMint();
  let confirmed = false;
  for (let i = 0; i < 10; i++) {
    const mintInfo = await connection.getParsedAccountInfo(mintKp.publicKey);
    if (mintInfo.value !== null) {
      console.log(
        "Mint account is confirmed as initialized. Owner:",
        mintInfo.value.owner.toBase58()
      );
      confirmed = true;
      break;
    }
    console.log("Waiting for mint account to initialize...");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!confirmed) {
    throw new Error("Mint account was not confirmed as initialized.");
  }
  return mintKp;
}

/**
 * Mints tokens to a given recipient.
 */
async function mintTokens(
  mintPublicKey: PublicKey,
  recipientPublicKey: PublicKey
) {
  console.log("Minting tokens...");
  // Get or create the associated token account for the recipient.
  const recipientATA = await spl.getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mintPublicKey,
    recipientPublicKey
  );
  // Mint tokens to the recipient's associated token account.
  await spl.mintTo(
    connection,
    payer,
    mintPublicKey,
    recipientATA.address,
    payer,
    1000000 // Adjust the amount as needed.
  );
  console.log(
    `Tokens minted successfully to ${recipientATA.address.toBase58()}!`
  );
}

/**
 * Main function to create a new pool bundle.
 * Prompts the user for pool parameters, optionally reinitializes global state,
 * creates a new mint if desired, registers metadata, mints some tokens, and
 * creates the pool “create” and buyer swap instructions.
 */
export async function buyBundle() {
  // Set up Anchor provider and program.
  const provider = new anchor.AnchorProvider(
    new anchor.web3.Connection(rpc),
    new anchor.Wallet(wallet),
    { commitment: "confirmed" }
  );
  const IDL_PumpFun = JSON.parse(
    fs.readFileSync("./pumpfun-IDL.json", "utf-8")
  ) as anchor.Idl;
  const program = new Program(IDL_PumpFun, PUMP_PROGRAM, provider);

  // Reinitialize global state if desired.
  const reinitGlobal =
    prompt("Reinitialize global state? (y/n): ").toLowerCase() === "y";
  let globalPDA: PublicKey;
  if (reinitGlobal) {
    const seed = "global-" + Date.now().toString();
    [globalPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(seed)],
      PUMP_PROGRAM
    );
    console.log(
      "Using new global PDA (seed =",
      seed,
      "):",
      globalPDA.toBase58()
    );
  } else {
    [globalPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("global")],
      PUMP_PROGRAM
    );
    console.log("Derived global PDA:", globalPDA.toBase58());
  }

  // Load buyer keypairs and keyInfo from file.
  const bundledTxns: VersionedTransaction[] = [];
  const keypairs: Keypair[] = loadKeypairs();
  let keyInfo: { [key: string]: any } = {};
  if (fs.existsSync(keyInfoPath)) {
    keyInfo = JSON.parse(fs.readFileSync(keyInfoPath, "utf-8"));
  }

  // Get the lookup table account.
  const lut = new PublicKey(keyInfo.addressLUT.toString());
  const lookupTableAccount = await getAddressLookupTableWithRetry(lut);
  if (lookupTableAccount === null) {
    console.log("Lookup table account not found!2");
    process.exit(0);
  }

  // Ask for pool parameters.
  const name = prompt("Name of your token: ");
  const symbol = prompt("Symbol of your token: ");
  const description = prompt("Description of your token: ");
  const twitter = prompt("Twitter of your token: ");
  const telegram = prompt("Telegram of your token: ");
  const website = prompt("Website of your token: ");
  const tipAmt = +prompt("Jito tip in SOL: ") * LAMPORTS_PER_SOL;

  // Read the image file for metadata.
  const files = await fs.promises.readdir("./img");
  if (files.length === 0) {
    console.log("No image found in the img folder");
    return;
  }
  if (files.length > 1) {
    console.log(
      "Multiple images found in the img folder; please only keep one image."
    );
    return;
  }
  const data: Buffer = fs.readFileSync(`./img/${files[0]}`);
  let formData = new FormData();
  formData.append("file", new Blob([data], { type: "image/jpeg" }));
  formData.append("name", name);
  formData.append("symbol", symbol);
  formData.append("description", description);
  formData.append("twitter", twitter);
  formData.append("telegram", telegram);
  formData.append("website", website);
  formData.append("showName", "true");

  let metadata_uri;
  try {
    const response = await axios.post("https://pump.fun/api/ipfs", formData, {
      headers: { "Content-Type": "multipart/form-data" },
    });
    metadata_uri = response.data.metadataUri;
    console.log("✅ Metadata URI:", metadata_uri);
  } catch (error) {
    console.error("❌ Error uploading metadata:", error);
    return;
  }

  // Decide whether to create a new mint.
  const useNewMint = prompt("Create a new mint? (y/n): ").toLowerCase() === "y";
  let mintKp: Keypair;
  if (useNewMint || !keyInfo.mintPk) {
    mintKp = await createAndConfirmMint();
    keyInfo.mint = mintKp.publicKey.toBase58();
    keyInfo.mintPk = bs58.encode(mintKp.secretKey);
    fs.writeFileSync(keyInfoPath, JSON.stringify(keyInfo, null, 2));
  } else {
    mintKp = Keypair.fromSecretKey(
      Uint8Array.from(bs58.decode(keyInfo.mintPk))
    );
  }
  console.log(`Mint: ${mintKp.publicKey.toBase58()}`);

  // Automatically register metadata for the new mint.
  await registerMetadata(
    mintKp.publicKey.toBase58(),
    name,
    symbol,
    metadata_uri
  );
  console.log("✅ Metadata registered successfully for:", name);

  // Mint some tokens to the pool creator’s wallet.
  await mintTokens(
    mintKp.publicKey,
    new PublicKey("6D8uwnVuAD2nxvDqWKu62Nh9NvXpJX8CsazHMRMbBi5V")
  );
  console.log(
    `✅ Minted tokens to 6D8uwnVuAD2nxvDqWKu62Nh9NvXpJX8CsazHMRMbBi5V`
  );

  // Derive PDAs for bonding curve, associated bonding curve, and metadata.
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mintKp.publicKey.toBytes()],
    program.programId
  );
  const [associatedBondingCurve] = PublicKey.findProgramAddressSync(
    [
      bondingCurve.toBytes(),
      spl.TOKEN_PROGRAM_ID.toBytes(),
      mintKp.publicKey.toBytes(),
    ],
    spl.ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const [metadataPDA] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      MPL_TOKEN_METADATA_PROGRAM_ID.toBytes(),
      mintKp.publicKey.toBytes(),
    ],
    MPL_TOKEN_METADATA_PROGRAM_ID
  );

  // Use wallet as the pool creator.
  const user = wallet;

  // Build the "create" instruction.
  const createIx = await program.methods
    .create(name, symbol, metadata_uri)
    .accounts({
      mint: mintKp.publicKey,
      mintAuthority,
      bondingCurve,
      associatedBondingCurve,
      global: globalPDA,
      mplTokenMetadata: MPL_TOKEN_METADATA_PROGRAM_ID,
      metadata: metadataPDA,
      user: user.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: spl.TOKEN_PROGRAM_ID,
      associatedTokenProgram: spl.ASSOCIATED_TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
      eventAuthority,
      program: PUMP_PROGRAM,
    })
    .instruction();

  // Create the associated token account (ATA) for the wallet.
  const ata = spl.getAssociatedTokenAddressSync(
    mintKp.publicKey,
    wallet.publicKey
  );
  const ataIx = spl.createAssociatedTokenAccountIdempotentInstruction(
    wallet.publicKey,
    ata,
    wallet.publicKey,
    mintKp.publicKey
  );

  // Derive the wallet’s associated token account (used in the buy instruction).
  const associatedUser = await spl.getAssociatedTokenAddress(
    mintKp.publicKey,
    wallet.publicKey
  );

  // Retrieve token parameters for the wallet from keyInfo.
  const keypairInfo = keyInfo[wallet.publicKey.toString()];
  if (!keypairInfo) {
    console.log(
      `No key info found for keypair: ${wallet.publicKey.toBase58()}`
    );
  }
  const amount = new BN(keypairInfo.tokenAmount);
  const solAmtBN = new BN(100000 * keypairInfo.solAmount * LAMPORTS_PER_SOL);

  console.log("Buy instruction accounts:", {
    global: globalPDA.toBase58(),
    feeRecipient: feeRecipient.toBase58(),
    mint: mintKp.publicKey.toBase58(),
    bondingCurve: bondingCurve.toBase58(),
    associatedBondingCurve: associatedBondingCurve.toBase58(),
    associatedUser: associatedUser.toBase58(),
    user: wallet.publicKey.toBase58(),
    systemProgram: SystemProgram.programId.toBase58(),
    tokenProgram: spl.TOKEN_PROGRAM_ID.toBase58(),
    rent: SYSVAR_RENT_PUBKEY.toBase58(),
    eventAuthority: eventAuthority.toBase58(),
    program: PUMP_PROGRAM.toBase58(),
  });

  // Build the "buy" instruction.
  const buyIx = await program.methods
    .buy(amount, solAmtBN)
    .accounts({
      global: globalPDA,
      feeRecipient: feeRecipient,
      mint: mintKp.publicKey,
      bondingCurve: bondingCurve,
      associatedBondingCurve: associatedBondingCurve,
      associatedUser: associatedUser,
      user: wallet.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: spl.TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
      eventAuthority: eventAuthority,
      program: PUMP_PROGRAM,
    })
    .instruction();

  // Create the tip (Jito) transfer instruction.
  const tipIxn = SystemProgram.transfer({
    fromPubkey: wallet.publicKey,
    toPubkey: getRandomTipAccount(),
    lamports: BigInt(tipAmt),
  });

  // Assemble all initialization instructions.
  const initIxs: TransactionInstruction[] = [createIx, ataIx, buyIx, tipIxn];
  const { blockhash } = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    instructions: initIxs,
    recentBlockhash: blockhash,
  }).compileToV0Message();
  const fullTX = new VersionedTransaction(messageV0);
  fullTX.sign([wallet, mintKp]);
  bundledTxns.push(fullTX);

  // ----- Step 3: Create swap transactions (simulate additional buys) -----
  const txMainSwaps: VersionedTransaction[] = await createWalletSwaps(
    blockhash,
    keypairs,
    lookupTableAccount,
    mintKp.publicKey,
    program
  );
  bundledTxns.push(...txMainSwaps);

  // ----- Step 4: Send the bundle -----
  await sendBundle(bundledTxns);
}

/**
 * createWalletSwaps:
 * For each buyer keypair, derive their associated token account,
 * add an instruction to create that account if needed, then build a buy instruction.
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

  // Derive bonding curve and associated bonding curve PDAs.
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBytes()],
    program.programId
  );
  const [associatedBondingCurve] = PublicKey.findProgramAddressSync(
    [bondingCurve.toBytes(), spl.TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
    spl.ASSOCIATED_TOKEN_PROGRAM_ID
  );
  // Use the fixed global PDA (seed "global").
  const [globalPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("global")],
    PUMP_PROGRAM
  );
  console.log("Derived global PDA:", globalPDA.toBase58());

  // Load keyInfo.
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
      const pubkeyStr = buyer.publicKey.toBase58();
      console.log(`Processing keypair ${i + 1}/${chunk.length}: ${pubkeyStr}`);

      // Derive the buyer's associated token account.
      const ataAddress = await spl.getAssociatedTokenAddress(
        mint,
        buyer.publicKey
      );
      const createTokenAtaIx =
        spl.createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          ataAddress,
          buyer.publicKey,
          mint
        );

      const buyerInfo = keyInfo[pubkeyStr];
      if (!buyerInfo || !buyerInfo.tokenAmount || !buyerInfo.solAmount) {
        console.log(`Incomplete key info for ${pubkeyStr}, skipping.`);
        continue;
      }
      const amount = new BN(buyerInfo.tokenAmount);
      const solAmtBN = new BN(100000 * buyerInfo.solAmount * LAMPORTS_PER_SOL);

      let buyIx: TransactionInstruction;
      try {
        buyIx = await program.methods
          .buy(amount, solAmtBN)
          .accounts({
            global: globalPDA,
            feeRecipient: feeRecipient,
            mint: mint,
            bondingCurve: bondingCurve,
            associatedBondingCurve: associatedBondingCurve,
            associatedUser: ataAddress,
            user: buyer.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: spl.TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
            eventAuthority: eventAuthority,
            program: PUMP_PROGRAM,
          })
          .instruction();
      } catch (err) {
        console.error(`Error creating buy instruction for2 ${pubkeyStr}:`, err);
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
      const serializedMsg = message.serialize();
      console.log("Txn size:", serializedMsg.length);
      if (serializedMsg.length > 1232) {
        console.log("Warning: Transaction size is too big.");
      }
      const versionedTx = new VersionedTransaction(message);
      console.log(
        "Signing transaction with chunk signers:",
        chunk.map((kp) => kp.publicKey.toBase58())
      );
      for (const kp of chunk) {
        if (keyInfo[kp.publicKey.toBase58()]) {
          versionedTx.sign([kp]);
        }
      }
      versionedTx.sign([payer]);
      txsSigned.push(versionedTx);
    }
  }
  return txsSigned;
}

function chunkArray<T>(array: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(array.length / size) }, (_, i) =>
    array.slice(i * size, i * size + size)
  );
}

/**
 * Sends the bundle via the searcher client.
 */
export async function sendBundle(bundledTxns: VersionedTransaction[]) {
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
