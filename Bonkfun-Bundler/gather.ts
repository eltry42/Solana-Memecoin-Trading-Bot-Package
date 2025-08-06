import base58 from "bs58"
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction
} from "@solana/web3.js"
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress
} from "@solana/spl-token"
import { SPL_ACCOUNT_LAYOUT, TokenAccount } from "@raydium-io/raydium-sdk"
import { readJson, retrieveEnvVariable, sleep } from "./utils"
import { getSellTxWithJupiter } from "./utils/swapOnlyAmm"
import { execute } from "./executor/legacy"
import { BUYER_WALLET, RPC_ENDPOINT, RPC_WEBSOCKET_ENDPOINT } from "./constants"
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

export const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
  commitment: "processed"
})

const rpcUrl = retrieveEnvVariable("RPC_ENDPOINT")
const mainKpStr = retrieveEnvVariable("PRIVATE_KEY")
const connection = new Connection(rpcUrl, { commitment: "processed" })

// Support both 32-byte and 64-byte base58-encoded keys
const loadKeypairFlexible = (encoded: string): Keypair => {
  const decoded = base58.decode(encoded)
  if (decoded.length === 64) return Keypair.fromSecretKey(decoded)
  if (decoded.length === 32) return Keypair.fromSeed(decoded)
  throw new Error(`Invalid secret key length: ${decoded.length} bytes`)
}

const mainKp = loadKeypairFlexible(mainKpStr)

const main = async () => {
  const walletsData = readJson()
  const wallets: Keypair[] = []

  for (const encoded of walletsData) {
    try {
      wallets.push(loadKeypairFlexible(encoded))
    } catch (e) {
      console.error(`Skipping invalid key: ${encoded}`, e)
    }
  }

  try {
    wallets.push(loadKeypairFlexible(BUYER_WALLET))
  } catch (e) {
    console.error("Invalid BUYER_WALLET:", e)
  }

  for (const [i, kp] of wallets.entries()) {
    try {
      await sleep(i * 50)
      const accountInfo = await connection.getAccountInfo(kp.publicKey)

      const tokenAccounts = await connection.getTokenAccountsByOwner(
        kp.publicKey,
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
        const baseAta = await getAssociatedTokenAddress(acc.accountInfo.mint, mainKp.publicKey)
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
            const sellTx = await getSellTxWithJupiter(kp, acc.accountInfo.mint, tokenBalance.amount)
            if (!sellTx) throw new Error("Error getting sell tx")
            const latestBlockhash = await solanaConnection.getLatestBlockhash()
            const txSellSig = await execute(sellTx, latestBlockhash, false)
            console.log("Success in Sell transaction:", `https://solscan.io/tx/${txSellSig}`)
            break
          } catch {
            retries++
            if (retries > 10) console.log("Sell retry limit reached")
          }
        }

        await sleep(1000)

        let tokenBalanceAfterSell
        try {
          tokenBalanceAfterSell = (await connection.getTokenAccountBalance(tokenAccount)).value
        } catch {
          console.warn("Token account disappeared after sell. Skipping post-sell ops.")
          continue
        }

        console.log("Wallet address & balance:", kp.publicKey.toBase58(), tokenBalanceAfterSell.amount)

        ixs.push(
          createAssociatedTokenAccountIdempotentInstruction(mainKp.publicKey, baseAta, mainKp.publicKey, acc.accountInfo.mint)
        )

        const tokenAccInfo = await connection.getAccountInfo(tokenAccount)
        if (tokenBalanceAfterSell.uiAmount > 0 && tokenAccInfo && tokenAccInfo.data.length > 0) {
          ixs.push(
            createTransferCheckedInstruction(
              tokenAccount,
              acc.accountInfo.mint,
              baseAta,
              kp.publicKey,
              BigInt(tokenBalanceAfterSell.amount),
              tokenBalanceAfterSell.decimals
            )
          )
        }

        ixs.push(createCloseAccountInstruction(tokenAccount, mainKp.publicKey, kp.publicKey))
      }

      if (accountInfo) {
        const solBal = await connection.getBalance(kp.publicKey)
        if (solBal > 0) {
          ixs.push(
            SystemProgram.transfer({
              fromPubkey: kp.publicKey,
              toPubkey: mainKp.publicKey,
              lamports: solBal
            })
          )
        }
      }

      if (ixs.length) {
        const tx = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 220_000 }),
          ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }),
          ...ixs
        )
        tx.feePayer = mainKp.publicKey
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash

        const sig = await sendAndConfirmTransaction(connection, tx, [mainKp, kp], { commitment: "confirmed" })
        console.log(`Closed and gathered SOL from wallet ${i}: https://solscan.io/tx/${sig}`)
      }
    } catch (error) {
      console.log(`Transaction error while gathering from wallet ${i}:`, error)
    }

    //run gather.ts in the other folder 
    const botFolderPath = path.resolve(__dirname, "../raydium-volume-bot-latest");
    console.log("Gathering vol bot funds...");
    const botProcess = spawn("npx", ["ts-node", "gather.ts"], {
      cwd: botFolderPath,
      stdio: "inherit",
      shell: true,
    });
  }
}

main()
