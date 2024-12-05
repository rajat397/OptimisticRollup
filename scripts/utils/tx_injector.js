const axios = require('axios');
const secp = require('ethereum-cryptography/secp256k1');
const { keccak256 } = require('ethereum-cryptography/keccak.js');
const { toHex, utf8ToBytes } = require('ethereum-cryptography/utils.js');
const { ethers } = require('ethers');

const sequencerUrl = `http://localhost:1225`;
const privateKey = '0xde9be858da4a475276426320d5e9262ecfc3ba460bfac56360bfa6c4c28b4ee0';
const targetAddress = '0xbDA5747bFD65F08deb54cb465eB87D40e51B197E';
const runs = 25000;
const transferAmount = '0.01';

function messageHash(target, value, nonce) {
  return keccak256(utf8ToBytes(JSON.stringify({ target, value, nonce })));
}

async function runTransactions() {
  const signer = new ethers.Wallet(privateKey);
  
  for (let i = 1; i <= runs; i++) {
    const nonce = i;
    const value = ethers.utils.parseEther(transferAmount).toString();

    // Create the hash and signature for the transaction
    const hash = messageHash(targetAddress, value, nonce);
    const [signature, recoveryBit] = await secp.sign(
      hash,
      privateKey.substring(2),
      { recovered: true }
    );

    // Send the transaction to the sequencer
    try {
      const response = await axios.post(`${sequencerUrl}/l2transfer`, {
        signature: toHex(signature),
        target: targetAddress,
        value: value,
        nonce: nonce,
        recoveryBit: recoveryBit
      });

      if (response.data.success) {
        console.log(`Transaction ${i} successfully injected`);
      } else {
        console.log(`Transaction ${i} failed: ${response.data.errormsg}`);
      }
    } catch (error) {
      console.error(`Error on transaction ${i}:`, error.message);
    }
  }
}

runTransactions().catch((error) => {
  console.error('Script failed:', error);
  process.exitCode = 1;
});
