// src/withdraw.ts
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";
import * as spl from "@solana/spl-token";
import { Program } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import fs from "fs";
import bs58 from "bs58";
import promptSync from "prompt-sync";
import {
  wallet,
  mintAuthority,
  global,
  feeRecipient,
  PUMP_PROGRAM,
  MPL_TOKEN_METADATA_PROGRAM_ID,
  eventAuthority,
  connection,
  rpc,
} from "../config"; // adjust the import path as needed

const prompt = promptSync();

export async function withdrawLiquidity() {
  // Set up the Anchor provider and program
  const provider = new anchor.AnchorProvider(
    new anchor.web3.Connection(rpc),
    new anchor.Wallet(wallet),
    { commitment: "confirmed" }
  );
  const idl = JSON.parse(fs.readFileSync("./pumpfun-IDL.json", "utf-8"));
  const program = new Program(idl, PUMP_PROGRAM, provider);

  // Load the mint keypair from your keyInfo file
  const keyInfoPath = "src/keyInfo.json";
  const keyInfo = JSON.parse(fs.readFileSync(keyInfoPath, "utf-8"));
  if (!keyInfo.mintPk) {
    console.error("mintPk not found in keyInfo.json");
    return;
  }
  const mintKp = anchor.web3.Keypair.fromSecretKey(
    Uint8Array.from(bs58.decode(keyInfo.mintPk))
  );
  console.log(`Using mint: ${mintKp.publicKey.toBase58()}`);

  // Derive the bonding curve PDAs
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

  // **Derive the associatedUser account (the ATA for your mint and wallet)**
  const associatedUser = await spl.getAssociatedTokenAddress(
    mintKp.publicKey,
    wallet.publicKey
  );
  console.log(
    `Associated token account for withdrawal: ${associatedUser.toString()}`
  );

  // Build the withdraw instruction with all required accounts, including associatedUser
  const withdrawIx = await program.methods
    .withdraw()
    .accounts({
      global: global, // Global PDA from your config
      mint: mintKp.publicKey, // The token mint
      bondingCurve: bondingCurve, // Derived PDA for bonding curve
      associatedBondingCurve: associatedBondingCurve, // Derived PDA for associated bonding curve
      associatedUser: associatedUser, // <-- Now provided!
      user: wallet.publicKey, // The admin/withdrawal wallet
      systemProgram: SystemProgram.programId,
      tokenProgram: spl.TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
      eventAuthority: eventAuthority,
      program: PUMP_PROGRAM,
    })
    .instruction();

  // Get a recent blockhash and build the transaction
  const { blockhash } = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [withdrawIx],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([wallet]);
  console.log("Sending withdraw transaction...");

  try {
    const txid = await connection.sendTransaction(tx, { maxRetries: 5 });
    console.log("Withdraw transaction sent, txid:", txid);
  } catch (error) {
    console.error("Error sending withdraw transaction:", error);
  }
}
