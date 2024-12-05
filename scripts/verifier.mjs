import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import brotli from 'brotli';
import ethers from 'ethers';
import assert from 'assert';
import pako from 'pako';
import { Semaphore } from './utils/semaphore.mjs';
import { Listner } from './utils/listner.mjs';
import events from 'events';
import {
    creatStateMerkleTree,
    createTrasactionMerkleTree,
    reCreateTransaction,
    maptoArray,
    l2Transaction,
    logError,
    logInfo,
    logWarn
} from './utils/utils.mjs'


const app = express();
app.use(express.json());
const sequencerurl = `http://localhost:${process.env.SEQUENCER_PORT}`;
var eventEmitter = new events.EventEmitter();


/**
 * Verifier Class
 */
class Verifier extends Listner {
    constructor() {
        super();
        this.privateKey = process.env.TESTNET_VERIFIER_PRIVATE_KEY;
        this.provider = new ethers.providers.JsonRpcProvider(process.env.LOCALHOST_HTTP_URL);
        this.signer = new ethers.Wallet(this.privateKey, this.provider);
        this.contract = new ethers.Contract(this.contractaddress, this.contractabi, this.signer);
        this.abicoder = ethers.utils.defaultAbiCoder;

        // fidelity bond in ethers
        this.fidelityBond = ethers.utils.parseEther("10");
        this.stateMap = undefined;

        // batch properties.
        this.sequencedTransactionBatch = [];
        this.prevStateRoot = undefined;
        this.postStateRoot = undefined;
        this.txRoot = undefined;
        this.batchId = undefined;
        this.batch = undefined;
        this.decompBatch = undefined;
        this.compBatch = undefined;

        // flag for malicious batch detection.
        this.maliciousBatch = false;

        // semaphore for thread safty.
        this.semaphore = new Semaphore();

        // veifier set this when he successfully challenge
        // a tx batch. Then set expectedId to the batch id.
        // Verifier will then wait until the sequenced batch
        // event for the expected id and neglect other events.
        this.challenged = false;
        this.expectedId = undefined;
    }

    get isBusy() {
        return this.semaphore.busy;
    }

    /**
     * status of the batch.
     */
    get cleanBatch() {
        return !this.maliciousBatch;
    }

    /**
     * clear listen batchId and allow verifier to
     * listen all incoming batches from the sequencer.
     */
    clearChallenge() {
        this.expectedId = undefined;
        this.challenged = false;
    }

    /**
     * set verifier to only listen to batchId and skip
     * all other batches from the sequencer.
     * @param {int} batchId
     */
    setChallenge(batchId) {
        this.expectedId = batchId;
        this.challenged = true;
    }

    async verifyTransactionsL1() {
        console.log("Verify transaction batch hash in l1.");
        console.log(` batch : ${this.compBatch}`);
        console.log(` batchId : ${this.batchId}`);
        console.log(` decomp batch length : ${this.decompBatch.length}`);
        const prevstatemap = await this.getState();
        const abiEncodedStateMap = this.abicoder.encode(["tuple(address _address, uint256 _value, uint256 _nonce)[] _users"],
            [maptoArray(prevstatemap)]);
        try {
            const options = { value: this.fidelityBond };
            const tx = await this.contract.verifyTransactions(this.compBatch,
                abiEncodedStateMap,
                this.batchId,
                this.decompBatch.length,
                options);
            const receipt = await tx.wait();
            console.log(receipt);
            if (receipt.status == 1) {
                logInfo(`Successfully challenged batch ${this.batchId}`);
                this.setChallenge(this.batchId);
            }
        } catch (error) {
            logError(`Verifier challenge attempt for batch ${this.batchId} failed`);
            logWarn(` ${error['error']['reason']}`);
        }
    }

    getState = async () => {
        const { data: jsonState } = await axios.post(`${sequencerurl}/getstatemap`, {
            batchId: this.batchId
        });
        console.log(jsonState);
        assert(jsonState != [], `StateMap for batch ${this.batchId} not found`);
        return new Map(jsonState);
    }

    async verifyBatch(calldata) {
        await this.semaphore.acquire();

        // clearing up vars.
        this.preVerifyRun();

        // decode calldata.
        this.decodeCalldata(calldata);

        // validate the pre-state.
        await this.validatePreState();

        // validate the transaction batch.
        if (this.cleanBatch)
            await this.validateTransactions();

        // validate the post-state.
        if (this.cleanBatch) {
            this.resequncene();
            this.validatePostState();
        }

        if (!this.cleanBatch)
            await this.verifyTransactionsL1();
        this.semaphore.release();
    }

    resequncene() {
        assert(this.sequencedTransactionBatch,
            "sequenced transaction batch should be set up before re-sequence.");
        assert(this.stateMap, "state map should be set up before re-sequence.");
        for (let id = 0; id < this.sequencedTransactionBatch.length; id++) {
            let tx = this.sequencedTransactionBatch[id];
            let txType = tx[l2Transaction.type];
            if (txType == 'deposit') {
                this.deposit(tx);
            } else if (txType == 'l2transfer') {
                this.l2transfer(tx);
            } else if (txType == 'withdraw') {
                this.withdraw(tx);
            } else {
                assert(0, "Undefined l2 transaction type.");
            }
        }
    }

    async validatePreState() {
        // get previous statemap from sequencer and validate.
        this.stateMap = await this.getState();
        assert(this.stateMap);
        if (creatStateMerkleTree(this.stateMap).root != this.prevStateRoot) {
            this.maliciousBatch = true;
            logError("pre-state root mismatch detected.");
        } else {
            console.log("pre-state successully verified.");
        }
    }

    /**
     * validate transaction batch.
     * re-create transaction queue for re-sequencing and
     * check the validity of transaction merkle root.
     */
    async validateTransactions() {
        this.reCreateTransactionQueue(this.batch);
        // - validate tx data with merkle root.
        const verifierTxTree = createTrasactionMerkleTree(this.sequencedTransactionBatch);
        if (verifierTxTree.root != this.txRoot) {
            logError("tx root mismatch detected.");
            this.maliciousBatch = true;
        }
    }

    /**
     * validate post-state root after
     * transaction re-sequence.
     */
    validatePostState() {
        console.log("post-state verification starting.")
        if (creatStateMerkleTree(this.stateMap).root != this.postStateRoot) {
            logError("post-state root mismatch detected.");
            this.maliciousBatch = true;
        } else {
            console.log("post-state successully verified.");
            this.clearChallenge();
        }
    }

    /**
     * pre-verify run clears up all
     * trasaction batch variables.
     * all transaction properties should be
     * cleared/emptied before starting verification. 
     */
    preVerifyRun() {
        this.sequencedTransactionBatch = [];
        this.prevStateRoot = undefined;
        this.postStateRoot = undefined;
        this.txRoot = undefined;
        this.batch = undefined;
        this.batchId = undefined;
        this.decompBatch = undefined;
        this.stateMap = undefined;
        this.maliciousBatch = false;
    }

    sequenceTx(tx) {
        this.sequencedTransactionBatch.push([tx.sender,
        tx.target,
        tx.type,
        String(tx.value),
        String(tx.nonce),
        String(tx.timestamp),
        String(tx.id)]);
    }

    deposit(tx) {
        /**
         * Deposit L1 to L2.
         * Deposit balances according to the emitted events 
         * in the L1. Here `tx.sender` and `tx.target` addresses are equal.
         */
        const sender = this.stateMap.get(tx[l2Transaction.sender]);
        if (sender == undefined) {
            let userdata = {
                'balance': BigInt(tx[l2Transaction.value]),
                'nonce': 0
            };
            this.stateMap.set(tx[l2Transaction.sender], userdata);
        } else {
            sender.balance = BigInt(sender.balance) + BigInt(tx[l2Transaction.value]);
        }
    }

    l2transfer(tx) {
        const sender = this.stateMap.get(tx[l2Transaction.sender]);
        const target = this.stateMap.get(tx[l2Transaction.target]);
        // sender should be in L2.
        if (sender == undefined) {
            return false;
        }
        // enough account balance to execute tx.
        if (BigInt(sender.balance) < BigInt(tx[l2Transaction.value])) {
            return false;
        }
        // check nonce.
        if (sender.nonce + 1 != tx[l2Transaction.nonce]) {
            return false;
        }

        if (target == undefined) {
            let userdata = {
                'balance': BigInt(tx[l2Transaction.value]),
                'nonce': 0
            };
            this.stateMap.set(tx[l2Transaction.target], userdata);
        } else {
            target.balance = BigInt(target.balance) + BigInt(tx[l2Transaction.value]);
        }
        // update sender
        sender.balance = BigInt(sender.balance) - BigInt(tx[l2Transaction.value]);
        sender.nonce += 1;
    }

    withdraw(tx) {
        const sender = this.stateMap.get(tx[l2Transaction.sender]);
        // sender should be in L2.
        if (sender == undefined) {
            return false;
        }
        // enough account balance to execute tx.
        if (BigInt(sender.balance) < BigInt(tx[l2Transaction.value])) {
            return false;
        }
        // check nonce.
        if (sender.nonce + 1 != tx[l2Transaction.nonce]) {
            return false;
        }
        sender.balance = BigInt(sender.balance) - BigInt(tx[l2Transaction.value]);
        sender.nonce += 1;
    }

    reCreateTransactionQueue(batch) {
        assert(typeof this.sequencedTransactionBatch !== 'undefined' &&
            this.sequencedTransactionBatch.length == 0,
            "sequenced transaction batch is not empty.");

        for (let id = 0; id < batch._txLog.length; id++) {
            const l2tx = reCreateTransaction(batch._txLog[id]._txid.toNumber(),
                batch._txLog[id]._sender,
                batch._txLog[id]._target,
                batch._txLog[id]._type.toString(),
                batch._txLog[id]._value.toString(),
                batch._txLog[id]._nonce.toNumber(),
                batch._txLog[id]._timestamp.toNumber());
            this.sequenceTx(l2tx);
        }
        assert(this.sequencedTransactionBatch.length,
            "sequenced transaction batch is empty.");
    }

    /**
     * Sanity checker for calldata decoding.
     */
    sanityChecksforArgs() {
        assert(this.batch, "undefined batch");
        assert(this.prevStateRoot, "undefined pre-state root");
        assert(this.postStateRoot, "undefined post-state root");
        assert(this.txRoot, "undefined tx root");
        assert(this.batchId >= 0, "undefined batch id");
        assert(this.decompBatch, "Undefined decompressed batch.");
        assert(this.compBatch, "undefined compressed batch");
        assert(!this.maliciousBatch,
            "malicious batch should not be set before pre-verification.");
    }

    /**
     * 
     * @param {*} calldata 
     */
    decodeCalldata(calldata) {
        this.prevStateRoot = calldata._preStateRoot;
        this.postStateRoot = calldata._postStateRoot;
        this.txRoot = calldata._txRoot;
        this.batchId = Number(calldata._batchId);

        // decode transactions
        const compalgo = 'pako';
        this.compBatch = new Uint8Array(Buffer.from(calldata._batch.substr(2), 'hex'));

        // data decompression.
        // data de/compression could be using several algorithms.
        // but we can only support pako algorithm in Ethereum at the moment.
        // Hence compalgo is hard coded to 'pako'.
        if (compalgo === 'brotli') {
            this.decompBatch = Buffer.from(brotli.decompress(this.compBatch));
        } else if (compalgo === 'pako') {
            console.log("decompressed string : ", pako.inflateRaw(this.compBatch, { level: 9 }));
            this.decompBatch = Buffer.from(pako.inflateRaw(this.compBatch, { level: 9 }));
        } else {
            assert(0, "Undefined de/compression algorithm.");
        }
        // debug.
        // console.log("Decompressed batch : ", this.decompBatch.toString('hex').match(/../g).join(' '));
        // console.log("Decompressed utf-8 : ", this.decompBatch.toString('utf-8'));

        // set batch and batch length.
        this.batch = this.abicoder.decode(["tuple(address _sender, address _target, string _type," +
            " uint256 _value,  uint256 _nonce, uint256 _timestamp, uint256 _txid)[] _txLog"],
            this.decompBatch.toString('utf-8'));
        this.sanityChecksforArgs();
    }

    async listner() {
        await this.semaphore.acquire();
        // const dateInSecs_start = Math.floor(new Date().getTime() / 1000);
        const dateInSecs_start = new Date().getTime();

        let events = await this.getevents();
        events.forEach(async (event) => {
            console.log(event);

            // retrieve transaction by the hash. 
            const tx = await this.provider.getTransaction(event.transactionHash);

            // decode arguments via the interface.
            const decodedCalldata = this.iface.decodeFunctionData(tx.data.slice(0, 10), tx.data);

            // decode function name called.
            const functionName = this.iface.getFunction(tx.data.slice(0, 10)).name;
            
            let verificationStartTime;
            // event trigers.
            if (event.event == 'SequencedBatch') {
                verificationStartTime = new Date().getTime();
                logInfo("Event: SequencedBatch");
                logInfo(`batch id : ${event.returnValues['_batchId']}`);
                if (!this.challenged) {
                    console.log("decodedCalldata: ", decodedCalldata);
                    this.verifyBatch(decodedCalldata);
                } else {
                    if (Number(event.returnValues['_batchId']) == this.expectedId) {
                        this.verifyBatch(decodedCalldata);
                    }
                }
                const verificationEndTime = new Date().getTime();
                const verificationTime = verificationEndTime-verificationStartTime;

                console.log(`Verification time of batchId: ${event.returnValues['_batchId']} is ${verificationTime}`);
            }
        });
        const dateInSecs_end = new Date().getTime();
        const elapsed = dateInSecs_end - dateInSecs_start;
        console.log(`Elapsed time ${elapsed}`);
        this.semaphore.release();
    }
}

const verifier = new Verifier();

function listner() {
    if (!verifier.isBusy)
        verifier.listner();
}

eventEmitter.on('listen', listner);
setInterval(() => { eventEmitter.emit('listen'); }, 60000);


app.listen(process.env.VERIFIER_PORT, () => {
    console.log(`Verifier is running on port ${process.env.VERIFIER_PORT}`);
});

