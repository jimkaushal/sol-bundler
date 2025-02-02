import { Connection, Keypair, PublicKey, Commitment } from "@solana/web3.js";
import bs58 from "bs58";
import * as dotenv from "dotenv";
dotenv.config();

/**
 * Returns a Uint8Array representing the secret key.
 * If the PRIVATE_KEY env variable starts with '[', it's assumed to be a JSON array.
 * Otherwise, it will be treated as a Base58-encoded string.
 */
function getSecretKey(): Uint8Array {
  const keyEnv = process.env.PRIVATE_KEY;
  if (!keyEnv) {
    throw new Error("PRIVATE_KEY not provided in environment.");
  }
  const trimmed = keyEnv.trim();
  if (trimmed.startsWith("[")) {
    // Assume it's a JSON array.
    try {
      const keyArray: number[] = JSON.parse(trimmed);
      return new Uint8Array(keyArray);
    } catch (err) {
      throw new Error("Failed to parse PRIVATE_KEY as JSON array: " + err);
    }
  } else {
    // Assume it's a Base58-encoded string.
    try {
      return bs58.decode(trimmed);
    } catch (err) {
      throw new Error("Failed to decode PRIVATE_KEY as Base58 string: " + err);
    }
  }
}

// Use the helper for both wallet and payer
// PRIV KEY OF DEPLOYER
export const wallet = Keypair.fromSecretKey(getSecretKey());
// PRIV KEY OF FEEPAYER
export const payer = Keypair.fromSecretKey(getSecretKey());

// ENTER YOUR RPC
export const rpc = process.env.SOLANA_RPC_URL ?? "";

/* DONT TOUCH ANYTHING BELOW THIS */

export const connection = new Connection(rpc, {
  commitment: "confirmed" as Commitment,
  confirmTransactionInitialTimeout: 60000, // timeout in milliseconds
});

export const PUMP_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

export const RayLiqPoolv4 = new PublicKey(
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
);

export const global = new PublicKey(
  "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"
);

export const mintAuthority = new PublicKey(
  "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM"
);

export const MPL_TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

export const eventAuthority = new PublicKey(
  "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"
);

export const feeRecipient = new PublicKey(
  "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM"
);
