import {
  PublicKey,
  Keypair,
  VersionedTransaction,
} from '@solana/web3.js';
import { SLIPPAGE } from '../constants';

const INPUT_MINT_SOL = 'So11111111111111111111111111111111111111112';

export const getBuyTxWithJupiter = async (
  wallet: Keypair,
  baseMint: PublicKey,
  amount: number
) => {
  try {
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${INPUT_MINT_SOL}&outputMint=${baseMint.toBase58()}&amount=${amount}&slippageBps=${SLIPPAGE}`;
    const quoteResponse = await (await fetch(quoteUrl)).json();

    if (!quoteResponse || quoteResponse.error) {
      console.error('Quote API failed:', quoteResponse);
      return null;
    }

    const swapRes = await (
      await fetch("https://quote-api.jup.ag/v6/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse,
          userPublicKey: wallet.publicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 600_000,
        }),
      })
    ).json();

    if (!swapRes.swapTransaction) {
      console.error('Swap API missing swapTransaction:', swapRes);
      return null;
    }

    const swapTransactionBuf = Buffer.from(swapRes.swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);

    return transaction;
  } catch (error) {
    console.error("Error getting buy transaction:", error);
    return null;
  }
};


export const getSellTxWithJupiter = async (
  wallet: Keypair,
  baseMint: PublicKey,
  amount: string
) => {
  try {
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${baseMint.toBase58()}&outputMint=${INPUT_MINT_SOL}&amount=${amount}&slippageBps=${SLIPPAGE}`;
    const quoteResponse = await (await fetch(quoteUrl)).json();

    if (!quoteResponse || quoteResponse.error) {
      console.error('Quote API failed:', quoteResponse);
      return null;
    }

    const swapRes = await (
      await fetch("https://quote-api.jup.ag/v6/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse,
          userPublicKey: wallet.publicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 600_000,
        }),
      })
    ).json();

    if (!swapRes.swapTransaction) {
      console.error('Swap API missing swapTransaction:', swapRes);
      return null;
    }

    const swapTransactionBuf = Buffer.from(swapRes.swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);

    return transaction;
  } catch (error) {
    console.error("Error getting sell transaction:", error);
    return null;
  }
};
