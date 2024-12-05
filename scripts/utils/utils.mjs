import fs from 'fs';
import * as abi_1 from "@ethersproject/abi";
import ethers from 'ethers';
import { keccak256 } from 'ethereum-cryptography/keccak.js';
import { StandardMerkleTree } from "../merkle-tree/dist/standard.js";
import { hexToBytes, bytesToHex, concatBytes, utf8ToBytes, toHex } from 'ethereum-cryptography/utils.js';
import secp from 'ethereum-cryptography/secp256k1.js';
import assert from 'assert';
import { defaultAbiCoder } from '@ethersproject/abi';

/**
 * L2 Transaction structure.
 */
const l2Transaction = {
    sender: 0,
    target: 1,
    type: 2,
    value: 3,
    nonce: 4,
    timestamp: 5,
    txid: 6
}

/**
 * L2 Transaction status.
 */
const l2Status = {
    PENDING: 0,
    ACCEPTED_IN_L2: 1,
    ACCEPTED_IN_L1: 2,
    FINALIZED: 3,
    REJECTED: 4,
    NONE: 10
}

const readContractABI = (contractABIPath) => {
    let contractABI;
    try {
        contractABI = JSON.parse(fs.readFileSync(contractABIPath)).abi;
    } catch (error) {
        console.log("unable to open file")
        console.error(error.message);
        process.exit();
    }
    return contractABI;
};

const maptoArray = (stateMap) => {
    // const sortedMap = new Map([...stateMap.entries()].sort());
    const arr = Array.from(stateMap);
    // convert value object to array.
    arr.forEach((i) => {
        i[1] = Object.values(i[1]);
    });
    for (let i = 0; i < arr.length; i++) {
        arr[i] = arr[i].flat(1);
    }
    return arr;
}

// create a merkle tree for state map.
const creatStateMerkleTree = (stateMap) => {
    const arr = maptoArray(stateMap);
    // leaf encoding - [user address, user balance, nonce]
    const leafEncoding = ['address', 'uint', 'uint'];
    console.log("sequencer balances: ", arr)
    const stateTree = StandardMerkleTree.of(arr, leafEncoding);
    return stateTree;
};

const createTrasactionMerkleTree = (transactionBatch) => {
    console.log("transaction batch: ", transactionBatch);
    // leaf encoding - [sender address, target address, tx type, value, nonce, timestamp, txid]
    const leafEncoding = ['address', 'address', 'string', 'uint', 'uint', 'uint', 'uint'];
    const transactionTree = StandardMerkleTree.of(transactionBatch,
        leafEncoding);
    return transactionTree;
};

/**
 * Returns hash value of the leaf for a proof.
 * @param {*} value candidate values of the leaf
 * @returns hex string.
 */
const standardLeafHash = (value) => {
    const types = ['address', 'address', 'string', 'uint', 'uint', 'uint', 'uint'];
    return bytesToHex(keccak256(keccak256(hexToBytes(defaultAbiCoder.encode(types, value)))));
};

/**
 * recover address from the signed transaction.
 * @param {*} signature transaction signature
 * @param {*} target target adddress
 * @param {*} value value
 * @param {*} nonce nonce
 * @param {*} recoveryBit address recover bit 
 * @returns sender address
 */
const recoverSender = (signature, target, value, nonce, recoveryBit) => {
    const msgHash = keccak256(utf8ToBytes(JSON.stringify({
        target: target,
        value: value,
        nonce: nonce
    })));

    // const msgHash = keccak256(utf8ToBytes(value));
    const recoveredPubkey = secp.recoverPublicKey(msgHash, signature, recoveryBit);
    const sender = toHex(keccak256(recoveredPubkey.slice(1)).slice(-20));
    return '0x' + sender;
};



// creating a transaction with extracted calldata for queuing.
// for Sequencer.
const createTransaction = (txId, sender, target, type, value, nonce) => {
    return {
        id: txId,
        sender: sender,
        target: target,
        type: type,
        value: value,
        nonce: nonce,
        timestamp: new Date().getTime(),
        status: l2Status.PENDING,
        batchid: undefined,
        errormsg: undefined,
        finality: undefined
    }
};

// recreate a transaction.
// for Verfier.
const reCreateTransaction = (txId, sender, target, type, value, nonce, timestamp) => {
    return {
        id: txId,
        sender: sender,
        target: target,
        type: type,
        value: value,
        nonce: nonce,
        timestamp: timestamp
    }
};

const intermState = (stateMap, txId) => {
    const interStateRoot = creatStateMerkleTree(stateMap).root;
    // intermediate state root hash in-dependance with tx id
    const imStateHash = abi_1.defaultAbiCoder.encode(['bytes32', 'uint'],
        [interStateRoot, txId]);
    // ethers.utils.hexlify.
    return [ethers.utils.hexlify(keccak256(keccak256(hexToBytes(imStateHash))))];
};

const intermStateTreeRoot = (intermStates) => {
    console.log("Interim States: ", intermStates);
    assert(intermStates, "Intermediate state roots should not be empty.");
    // leaf encoding - [32bytes string]
    const leafEncoding = ['string'];
    return StandardMerkleTree.of(intermStates, leafEncoding).root;
};

const logError = (msg) => {
    console.error('\x1b[31m%s\x1b[0m', msg);
}

const logInfo = (msg) => {
    console.log('\x1b[32m%s\x1b[0m', msg);
}

const logWarn = (msg) => {
    console.warn('\x1b[33m%s\x1b[0m', msg);
}

const fakeRoot = () => {
    return '0x' + keccak256("fakeRoot").toString('hex');
}

/**
 * Count zero bytes in calldata
 * @param {string} data hex string of calldata 
 * @returns count of zero bytes
 */
const count_zero_bytes = (data) => {
    let count = 0
    for (let i = 0; i < data.length; i = i + 2) {
        const byte = data[i] + data[i + 1];
        if (byte == "00")
            count += 1
    }
    return count
}

/**
 * Count non-zero bytes in calldata
 * @param {string} data hex string of calldata 
 * @returns count of non-zero bytes
 */
const count_non_zero_bytes = (data) => {
    return (data.length / 2) - count_zero_bytes(data)
}

/**
 * Estimates gas cost of calldata
 * @param {string} data hex string of calldata 
 * @returns estimated gas cost in wei
 */
const estimate_calldata_cost = (data) => {
    return count_zero_bytes(data) * 4 + count_non_zero_bytes(data) * 16;
}

/**
 * Estimate fee savings from L1 gas cost on calldata
 * @param {string} uncompressed raw calldata (hex)
 * @param {string} compressed compressed calldata (hex)
 * @returns percentage fee savings
 */
const estimate_fee_savings = (uncompressed, compressed) => {
    const uncomp_gas_cost = estimate_calldata_cost(uncompressed);
    const comp_gas_cost = estimate_calldata_cost(compressed);
    assert(uncomp_gas_cost - comp_gas_cost > 0,
        "raw calldata cost shall not be lower than compressed calldata");
    return (uncomp_gas_cost - comp_gas_cost) / uncomp_gas_cost * 100;
}

export {
    readContractABI,
    creatStateMerkleTree,
    createTrasactionMerkleTree,
    createTransaction,
    reCreateTransaction,
    intermState,
    intermStateTreeRoot,
    maptoArray,
    l2Transaction,
    logError,
    logInfo,
    logWarn,
    fakeRoot,
    l2Status,
    standardLeafHash,
    recoverSender,
    estimate_fee_savings
}