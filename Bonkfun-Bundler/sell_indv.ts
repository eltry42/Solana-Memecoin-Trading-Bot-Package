import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js"
import {
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token"
import { SPL_ACCOUNT_LAYOUT, TokenAccount } from "@raydium-io/raydium-sdk"
import { getSellTxWithJupiter } from "./utils/swapOnlyAmm"
import { execute } from "./executor/legacy"
import { sleep } from "./utils"

export const SellFromWallet = async (
  connection: Connection,
  wallet: Keypair,
): Promise<void> => {
  try {
    const tokenAccounts = await connection.getTokenAccountsByOwner(
      wallet.publicKey,
      { programId: TOKEN_PROGRAM_ID },
      "confirmed"
    )

    const ixs: TransactionInstruction[] = []
    const accounts: TokenAccount[] = []

    for (const { pubkey, account } of tokenAccounts.value) {
      accounts.push({
        pubkey,
        programId: account.owner,
        accountInfo: SPL_ACCOUNT_LAYOUT.decode(account.data),
      })
    }

    for (const acc of accounts) {
      const tokenAccount = acc.pubkey

      let tokenBalance
      try {
        tokenBalance = (await connection.getTokenAccountBalance(tokenAccount)).value
      } catch {
        console.warn(`Skipping missing or closed token account: ${tokenAccount.toBase58()}`)
        continue
      }

      let retries = 0
      while (tokenBalance.uiAmount !== 0 && retries <= 10) {
        try {
          const sellTx = await getSellTxWithJupiter(wallet, acc.accountInfo.mint, tokenBalance.amount)
          if (!sellTx) throw new Error("Error getting sell tx")
          const latestBlockhash = await connection.getLatestBlockhash()
          const txSellSig = await execute(sellTx, latestBlockhash, false)
          console.log("✅ Success: Sold tokens from", wallet.publicKey.toBase58(), `→ https://solscan.io/tx/${txSellSig}`)
          break
        } catch {
          retries++
          if (retries > 10) console.log("Sell retry limit reached for", wallet.publicKey.toBase58())
        }
      }

      await sleep(1000)

      let tokenBalanceAfterSell
      try {
        tokenBalanceAfterSell = (await connection.getTokenAccountBalance(tokenAccount)).value
      } catch {
        console.warn("Token account disappeared after sell. Skipping close.")
        continue
      }

      console.log("Post-sell token balance:", tokenBalanceAfterSell.amount)

      // Always close token account (reclaim rent)
      ixs.push(createCloseAccountInstruction(tokenAccount, wallet.publicKey, wallet.publicKey))
    }

    if (ixs.length) {
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 220_000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }),
        ...ixs
      )
      tx.feePayer = wallet.publicKey
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash

      const sig = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: "confirmed" })
      console.log(`🧹 Token accounts closed for ${wallet.publicKey.toBase58()}: https://solscan.io/tx/${sig}`)
    }
  } catch (error) {
    console.error(`Error processing wallet ${wallet.publicKey.toBase58()}:`, error)
  }
}
