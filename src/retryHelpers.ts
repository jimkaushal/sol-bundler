// src/retryHelpers.ts
import { connection } from "../config";

/**
 * Attempts to fetch the latest blockhash with retries.
 *
 * @param retries Number of retry attempts (default: 3)
 * @param delayMs Delay between attempts in milliseconds (default: 1000)
 * @returns A promise resolving to an object containing the latest blockhash and last valid block height.
 * @throws Error if all attempts fail.
 */
export async function getLatestBlockhashWithRetry(
  retries = 3,
  delayMs = 1000
): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
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
  // Should never be reached.
  throw new Error("Unexpected error in getLatestBlockhashWithRetry");
}
