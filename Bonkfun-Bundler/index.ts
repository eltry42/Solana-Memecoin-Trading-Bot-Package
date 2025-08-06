import { VersionedTransaction, Keypair, Connection, ComputeBudgetProgram, TransactionInstruction, TransactionMessage, PublicKey } from "@solana/web3.js"
import base58 from "bs58"
import { DISTRIBUTION_WALLETNUM, PRIVATE_KEY, RPC_ENDPOINT, RPC_WEBSOCKET_ENDPOINT, SWAP_AMOUNT, BUYER_AMOUNT, VANITY_MODE, CREATION_KEY, VOL_BOT_TIMEOUT } from "./constants"
import { generateVanityAddress, saveDataToFile, sleep, readJson } from "./utils"
import { distributeSol, addBonkAddressesToTable, createLUT, makeBuyIx, createBonkFunTokenMetadata, createBonkTokenTx, createTokenTx } from "./src/main";
import { executeJitoTx } from "./executor/jito";
import { SellFromWallet } from "./sell_indv";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";


const commitment = "confirmed"

const connection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT, commitment
})
const mainKp = Keypair.fromSecretKey(base58.decode(PRIVATE_KEY))
const creatorKp = Keypair.fromSecretKey(base58.decode(CREATION_KEY))
console.log(mainKp.publicKey.toBase58())

let kps: Keypair[] = []
const transactions: VersionedTransaction[] = []
const creator_transactions: VersionedTransaction[] = []

let mintKp = Keypair.generate()
console.log("mintKp", mintKp.publicKey.toString());

if (VANITY_MODE) {
  const { keypair, pubkey } = generateVanityAddress("bonk")
  mintKp = keypair
  console.log(`Keypair generated with "bonk" ending: ${pubkey}`);
}

const mintAddress = mintKp.publicKey
console.log("mintAddress", mintAddress.toString());


const main = async () => {
  await createBonkFunTokenMetadata();

  const mainBal = await connection.getBalance(mainKp.publicKey)
  console.log((mainBal / 10 ** 9).toFixed(3), "SOL in main keypair")

  console.log("Mint address of token ", mintAddress.toBase58())
  saveDataToFile([base58.encode(mintKp.secretKey)], "mint.json")
  saveDataToFile([mintKp.publicKey.toBase58()], "pub_mint.json")

  const minimumSolAmount = (SWAP_AMOUNT + 0.01) * DISTRIBUTION_WALLETNUM + 0.05

  if (mainBal / 10 ** 9 < minimumSolAmount) {
    console.log("Main wallet balance is not enough to run the bundler")
    console.log(`Plz charge the wallet more than ${minimumSolAmount}SOL`)
    return
  }

  console.log("Distributing SOL to wallets...")
  let result = await distributeSol(connection, mainKp, DISTRIBUTION_WALLETNUM)
  if (!result) {
    console.log("Distribution failed")
    return
  } else {
    kps = result
  }


  console.log("Creating LUT started")
  const lutAddress = await createLUT(mainKp)
  if (!lutAddress) {
    console.log("Lut creation failed")
    return
  }
  console.log("LUT Address:", lutAddress.toBase58())
  saveDataToFile([lutAddress.toBase58()], "lut.json")
  await addBonkAddressesToTable(lutAddress, mintAddress, kps, mainKp)

  const buyIxs: TransactionInstruction[] = []

  for (let i = 0; i < DISTRIBUTION_WALLETNUM; i++) {
    const ix = await makeBuyIx(kps[i], Math.floor(SWAP_AMOUNT * 10 ** 9), i, creatorKp.publicKey, mintKp.publicKey /*new PublicKey("Y9YW5uaPfFtQuwbe6z9namDn8S1JoTHAD29j7opbonk")*/)
    buyIxs.push(...ix)
  }

  console.log("Buy instructions: ", buyIxs)


  const lookupTable = (await connection.getAddressLookupTable(lutAddress)).value;
  if (!lookupTable) {
    console.log("Lookup table not ready")
    return
  }
  console.log("Lookup table is ready, address:", lookupTable.key.toBase58())


  const tokenCreationTx = await createBonkTokenTx(connection, creatorKp, mintKp)

  console.log("Token creation transaction created, size:", tokenCreationTx.serialize().length, "bytes")

  transactions.push(tokenCreationTx)
  const latestBlockhash = await connection.getLatestBlockhash()
  console.log("Executing token creation transaction...")
  for (let i = 0; i < Math.ceil(DISTRIBUTION_WALLETNUM / 5); i++) {
    if (!latestBlockhash) {
      console.log("Failed to get latest blockhash")
      return
    }
    console.log("Latest blockhash:", latestBlockhash.blockhash)
    const instructions: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
    ]

    for (let j = 0; j < 5; j++) {
      const index = i * 5 + j
      if (kps[index]) {
        instructions.push(buyIxs[index * 5], buyIxs[index * 5 + 1], buyIxs[index * 5 + 2], buyIxs[index * 5 + 3], buyIxs[index * 5 + 4])
      }
    }
    console.log("fee payer kps[i * 5].publicKey", kps[i * 5]?.publicKey?.toBase58())
    instructions.map(ix => ix.keys.map(k => console.log("Key:", k.pubkey.toBase58(), " | Signer:", k.isSigner, " | Writable:", k.isWritable)))

    console.log("Instructions length:", instructions.length)
    console.log("Instructions: ", instructions)

    const msg = new TransactionMessage({
      payerKey: kps[i * 5].publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions
    }).compileToV0Message(/*[lookupTable]*/)

    console.log("Transaction message created, size:", msg.serialize().length, "bytes")

    const tx = new VersionedTransaction(msg)
    console.log("Transaction created, size:", tx.serialize().length, "bytes")
    for (let j = 0; j < 5; j++) {
      const index = i * 5 + j;
      const kp = kps[index];
      console.log("index", index, " | Keypair public key:", kp?.publicKey?.toBase58());
      if (kp) {
        console.log("Signing transaction with keypair:", kp.publicKey.toBase58());
        tx.sign([kp]);
        console.log("Transaction signed with keypair:", kp.publicKey.toBase58());
      } else {
        console.log("No keypair found at index", index);
      }
    }
    transactions.push(tx)
    console.log("Transaction created, size:", tx.serialize().length, "bytes")
  }
  console.log("Buy transactions created, total size:", transactions.reduce((acc, tx) => acc + tx.serialize().length, 0), "bytes")

  transactions.map(async (tx, i) => console.log(i, " | ", tx.serialize().length, "bytes | \n", (await connection.simulateTransaction(tx, { sigVerify: true }))))

  // // === Creator Buy and Sell BEFORE public buyers ===
  console.log("Creating creator buy INSTRUCTIONS...")
  const creatorBuyIx = await makeBuyIx(creatorKp, Math.floor(BUYER_AMOUNT * 10 ** 9), 0, creatorKp.publicKey, mintAddress)

  if (!creatorBuyIx) {
    console.log("Creator buy transaction failed or skipped")
    return;
  }

  const creatorInstructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
    ...creatorBuyIx,
  ];

  const creatorBlockhash = latestBlockhash;

  const creatorMessage = new TransactionMessage({
    payerKey: creatorKp.publicKey,
    recentBlockhash: creatorBlockhash.blockhash,
    instructions: creatorInstructions
  }).compileToV0Message(/* optionally pass [lookupTable] */);

  const creatorTx = new VersionedTransaction(creatorMessage);
  creatorTx.sign([creatorKp]);
  transactions.push(creatorTx);

  console.log("✅ Creator buy transaction created and signed.");

  console.log("Executing transactions...")
  await executeJitoTx(transactions, mainKp, commitment)
  await sleep(10 * 1000)

  console.log("Gathering and selling tokens from creator...")
  await SellFromWallet(connection, creatorKp)

  vol_trading()
}

main()

const vol_trading = async () => {
  console.log("VOLUME TRADING IN PROGRESS...");

  const botFolderPath = path.resolve(__dirname, "../raydium-volume-bot-latest");
  const envPath = path.join(botFolderPath, ".env");

  // Step 1: Load current .env content
  let envLines: string[] = [];
  if (fs.existsSync(envPath)) {
    envLines = fs.readFileSync(envPath, "utf8").split("\n");
  }

  // Step 2: Read mint address
  const token_cas = readJson("pub_mint.json");
  const token_ca = token_cas[token_cas.length - 1];

  // Step 3: Update TOKEN_MINT line in-place
  let found = false;
  envLines = envLines.map((line) => {
    if (line.startsWith("TOKEN_MINT=")) {
      found = true;
      return `TOKEN_MINT=${token_ca}`;
    }
    return line;
  });

  if (!found) {
    envLines.push(`TOKEN_MINT=${token_ca}`);
  }

  // Step 4: Write back the updated .env
  fs.writeFileSync(envPath, envLines.join("\n"), "utf8");
  console.log("✅ Updated .env with mint:", token_ca);

  // Step 5: Run the bot's index.ts using ts-node
  console.log("🚀 Launching Raydium volume bot...");
  const botProcess = spawn("npx", ["ts-node", "index.ts"], {
    cwd: botFolderPath,
    stdio: "inherit",
    shell: true,
  });

  setTimeout(() => {
    console.log("⏰ 10 minutes passed. Terminating the volume bot...");
    botProcess.kill(); // Sends SIGTERM by default
  }, VOL_BOT_TIMEOUT);

  botProcess.on("close", (code) => {
    console.log(`📦 Volume bot process exited with code ${code}`);
  });
}

//for testing function 
// vol_trading()