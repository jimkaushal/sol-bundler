import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import bs58 from "bs58";
import * as dotenv from "dotenv";
dotenv.config();

// PRIV KEY OF DEPLOYER
export const wallet = Keypair.fromSecretKey(
  bs58.decode(process.env.PRIVATE_KEY ?? "")
);

// PRIV KEY OF FEEPAYER
export const payer = Keypair.fromSecretKey(
  bs58.decode(process.env.PRIVATE_KEY ?? "")
);

// ENTER YOUR RPC
export const rpc = process.env.SOLANA_RPC_URL ?? "";

/* DONT TOUCH ANYTHING BELOW THIS */

export const connection = new Connection(rpc, "confirmed");

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

/**
 * Retries an asynchronous function a given number of times with a delay between attempts.
 *
 * @param fn - A function that returns a Promise.
 * @param retries - Number of retry attempts (default is 3).
 * @param delayMs - Delay between attempts in milliseconds (default is 1000ms).
 * @returns The result of the async function if successful.
 * @throws The last error if all attempts fail.
 */
async function retryAsync<T>(
  fn: () => Promise<T>,
  retries: number = 3,
  delayMs: number = 1000
): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      console.warn(
        `Attempt ${attempt} failed: ${error}. Retrying in ${delayMs}ms...`
      );
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

/**
 * Fetch the Address Lookup Table account with retries.
 *
 * @param lut - The lookup table public key.
 * @param retries - Number of retry attempts.
 * @param delayMs - Delay between attempts in milliseconds.
 * @returns The AddressLookupTableAccount.
 */
export async function getAddressLookupTableWithRetry(
  lut: PublicKey,
  retries: number = 3,
  delayMs: number = 1000
): Promise<AddressLookupTableAccount | null> {
  const result = await retryAsync(
    () => connection.getAddressLookupTable(lut),
    retries,
    delayMs
  );
  return result.value; // result has the shape { value: AddressLookupTableAccount | null, ... }
}
