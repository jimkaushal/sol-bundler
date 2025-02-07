import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  createMetadataAccountV3,
  CreateMetadataAccountV3InstructionAccounts,
  CreateMetadataAccountV3InstructionArgs,
  DataV2Args,
} from "@metaplex-foundation/mpl-token-metadata";
import {
  createSignerFromKeypair,
  signerIdentity,
  PublicKey,
} from "@metaplex-foundation/umi";
import { findMetadataPda } from "@metaplex-foundation/mpl-token-metadata";
import base58 from "bs58";
import { payer, connection } from "../config";
import { publicKey } from "@metaplex-foundation/umi";
/**
 * Registers on‑chain metadata for a mint.
 *
 * @param mint - The mint PublicKey.
 * @param name - The token name.
 * @param symbol - The token symbol.
 * @param uri - The URI pointing to the metadata JSON.
 * @param mintAuthority - The mint authority PublicKey.
 * @param updateAuthority - The update authority PublicKey.
 *
 * @returns The transaction signature that created the metadata account.
 */
export default async function registerMetadata(
  mint: string,
  name: string,
  symbol: string,
  uri: string,
  mintAuthority?: PublicKey,
  updateAuthority?: PublicKey
): Promise<any> {
  console.log(`Registering metadata for ${name} (${symbol})...`);
  // Define our Mint address

  // Create a UMI connection
  const umi = createUmi("https://api.mainnet-beta.solana.com");
  const keypair = umi.eddsa.createKeypairFromSecretKey(
    new Uint8Array(payer.secretKey)
  );
  const signer = createSignerFromKeypair(umi, keypair);
  umi.use(signerIdentity(createSignerFromKeypair(umi, keypair)));

  try {
    const metadataPda = findMetadataPda(umi, {
      mint: publicKey(mint),
    });

    const accounts: CreateMetadataAccountV3InstructionAccounts = {
      metadata: metadataPda,
      mint: publicKey(mint),
      mintAuthority: signer,
      payer: signer,
      updateAuthority: signer.publicKey,
    };

    const data: DataV2Args = {
      name,
      symbol,
      uri,
      sellerFeeBasisPoints: 500,
      creators: null,
      uses: null,
      collection: null,
    };

    const args: CreateMetadataAccountV3InstructionArgs = {
      data: data,
      isMutable: true,
      collectionDetails: null,
    };

    let tx = createMetadataAccountV3(umi, {
      ...accounts,
      ...args,
    });

    let result = await tx.sendAndConfirm(umi);

    console.log(base58.encode(result.signature));
  } catch (e) {
    console.error(`Oops, something went wrong: ${e}`);
  }
}
