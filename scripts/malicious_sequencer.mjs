import 'dotenv/config';
import express from 'express';
import events from 'events';
import pako from 'pako';
import { Queue } from './utils/queue.mjs';
import brotli from 'brotli';
import ethers from 'ethers';
import { Semaphore } from './utils/semaphore.mjs';
import { Listner } from './utils/listner.mjs';
import {
    creatStateMerkleTree,
    createTrasactionMerkleTree,
    createTransaction,
    logError,
    logInfo,
    logWarn,
    l2Status,
    recoverSender,
    estimate_fee_savings
} from './utils/utils.mjs'
import { assert } from 'console';
import { getAddress } from '@ethersproject/address';

let eventEmitter = new events.EventEmitter();
const app = express();
app.use(express.json());


class Sequencer extends Listner {
    constructor() {
        super();
        this.privateKey = process.env.TESTNET_SEQUENCER_PRIVATE_KEY;
        this.provider = new ethers.providers.JsonRpcProvider(process.env.LOCALHOST_HTTP_URL);
        this.signer = new ethers.Wallet(this.privateKey, this.provider);

        this.contract = new ethers.Contract(this.contractaddress, this.contractabi, this.signer);

        this.sequencedTransactionBatch = [];
        this.stateMap = new Map();
        // adding a default unusable world state.
        this.stateMap.set("0x0000000000000000000000000000000000000000",
            { 'balance': 0, 'nonce': 0 });

        // fidelity bond in ethers
        this.fidelityBond = ethers.utils.parseEther("10");

        // transaction queue.
        // queue contains transactions to be executed/sequenced
        // by the sequencer. It will contain tx reference where
        // transaction data could be referenced through the txMap.
        this.queue = new Queue();

        // transaction data storage.
        // txMap store all transactions in txid (key)
        // to tx data (value) structure.
        this.txMap = new Map();
        this.tx = undefined;
        this.txref = undefined;

        // maximum transactions in a sequenced batch.
        this.maxtransactions = 10;

        // uncle block gathers all the rejected
        // transaction references and kept for 'creation time +
        // this.retentionTime' long for user reference.
        this.uncleblock = [];

        // transaction batches sequenced by the sequencer.
        // once a dispute is detected transactions
        // are re-queued for reexecution.
        this.posttxbatches = [];
        this.executedtxbatch = [];
        this.batchoffset = 0;

        // state map tree to store world state
        // to be used for verifiers.
        // assumption is made this state is always
        // verified.
        // in the case of a successful dispute, sequencer
        // should modify the verified states accordingly. 
        this.prestates = [];

        // `batchId` carries a unique number for each batch
        // regardless of the validity of the batch.
        this.batchId = 0;

        this.prevStateRoot = undefined;
        this.postStateRoot = undefined;
        this.txRoot = undefined;
        this.txblocktimestamp = undefined;

        // challenge time should be set in milliseconds.
        this.challengeTime = 10 * 60000; // 10 mins

        // transaction retention time in sequencer logs.
        // this decides how long a transaction record is kept
        // with sequencer storages.
        this.retentionTime = 30 * 60000; // 30 mins

        // **** sequencer test ****
        // testing a malicious sequencer re-batching
        // mechanism.
        // maliciousIds is an array which includes the batch ids where
        // the sequencer is expected to act fradulently.
        this.maliciousIds = [];

        this.semaphore = new Semaphore();
    }

    get isBusy() {
        return this.semaphore.busy;
    }

    // returns ref batch location of a batch.
    batchLoc(batchId) {
        assert(batchId >= this.batchoffset,
            "batchid should be greater than batch offset.");
        return batchId - this.batchoffset;
    }

    // act maliciously at a given batch id.
    actMaliciousAt(batchId) {
        this.maliciousIds.push(batchId);
    }

    getPrestate(batchId) {
        assert(this.prestates.length,
            "Empty prestates array.");
        return this.prestates[this.batchLoc(batchId)];
    }

    // update sequencer for rebatch.
    reBatch(rebatchId) {
        logWarn("Sequencer resetting for batch ", rebatchId);
        assert(rebatchId < this.batchId, "current batch < rebatch id");
        this.batchId = rebatchId;

        // get pre-state correspond to re-batch id.
        const prestatemap = this.getPrestate(this.batchLoc(rebatchId));

        // set new state map.
        this.stateMap = new Map(JSON.parse(prestatemap));
        assert(this.stateMap, "undefined state map.");

        console.log("prestates len : ", this.prestates.length);
        console.log("posttxbatches len : ", this.posttxbatches.length);

        assert(this.prestates.length == this.posttxbatches.length);
        const batchloc = this.batchLoc(rebatchId);

        console.log("reabatch location : ", batchloc);
        assert(batchloc < this.prestates.length,
            "invaild batch location.");

        logWarn("Transaction pool resetting.");
        const len = this.prestates.length;
        for (let i = batchloc; i < len; i++) {
            this.prestates.pop();
            const batch = this.posttxbatches.pop();
            console.log(batch);
            this.reQueue(batch);
        }
        this.queue.qsort();
    }

    /**
     * sequencer batch chains prestates and post
     * tx batch chain should be rescheduled according 
     * to the maturity conditions in the L1. Once the 
     * state-commitment-chain is released with matured
     * blocks, it should reflect in the local chains.
     */
    async updateLocalBatchChains() {
        const l1BatchOffset = Number(await this.contract.batchoffset());
        if (this.batchoffset < l1BatchOffset) {
            logInfo("Rescheduling sequencer batch chains.");
            logInfo("Matured batches in l1 detected. sequencer chains rescheduling.");
            const diff = l1BatchOffset - this.batchoffset;
            console.log("l1 batch offset : ", l1BatchOffset);
            console.log("l2 batch offset : ", this.batchoffset);
            console.log("difference : ", diff);
            console.log("prestates.length : ", this.prestates.length);
            console.log("posttxbatches.length : ", this.posttxbatches.length);
            assert(diff <= this.prestates.length);
            assert(diff <= this.posttxbatches.length);

            // remove matured batches with compatible to the L1 chain.
            for (let i = 0; i < diff; i++) {
                this.prestates.shift();
                const txrefs = this.posttxbatches.shift();
                // remove finalized transactions from the txMap.
                for (let j = 0; j < txrefs.length; j++) {
                    this.txMap.delete(txrefs[j].id);
                }
            }
            this.batchoffset = l1BatchOffset;
        }
    }

    async updateBatchId() {
        const l1BatchId = await this.contract.batchId();
        this.batchId = Number(l1BatchId);
    }

    /**
     * 
     * @param {array} batch transaction batch.
     */
    reQueue(batch) {
        // re-queue to the mempool.
        for (let i = 0; i < batch.length; i++) {
            this.queue.push(batch[i]);
            this.setPending(batch[i]);
        }
    }

    acceptBatchinL1(batch) {
        this.posttxbatches.push(batch);
        // accept txs in l1.
        for (let i = 0; i < batch.length; i++) {
            this.setAcceptedinL1(batch[i]);
        }
    }

    setAcceptedinL1(txref) {
        const tx = this.txMap.get(txref.id);
        tx.status = l2Status.ACCEPTED_IN_L1;
        tx.batchid = this.batchId;
        tx.finality = this.txblocktimestamp + this.challengeTime;
    }

    setFinalized(txref) {
        const tx = this.txMap.get(txref.id);
        if (tx.status == l2Status.ACCEPTED_IN_L1) {
            assert(tx.finality);
            const now = new Date().getTime();
            if (now > tx.finality) {
                tx.status = l2Status.FINALIZED;
            }
        }
    }

    setAcceptedinL2(txref) {
        const tx = this.txMap.get(txref.id);
        tx.status = l2Status.ACCEPTED_IN_L2;
    }

    setPending(txref) {
        const tx = this.txMap.get(txref.id);
        tx.status = l2Status.PENDING;
        tx.batchid = undefined;
        tx.finality = undefined;
    }

    updateBatchFinality() {
        // set finality of local blocks.
        for (let i = 0; i < this.posttxbatches.length; i++) {
            const batch = this.posttxbatches[i];
            for (let j = 0; j < batch.length; j++) {
                this.setFinalized(batch[j]);
            }
        }
    }

    cleanStorage() {
        // clean rejected transactions if there are
        // kept over a certain time period.
        let expired = 0;
        this.uncleblock.sort((a, b) => a.timestamp - b.timestamp );
        for (let i = 0; i < this.uncleblock.length; i++) {
            let now = new Date().getTime();
            let expireTime = this.uncleblock[i].timestamp + this.retentionTime;
            if (now > expireTime) {
                expired++;
                this.txMap.delete(this.uncleblock[i].id);
            }
        }

        for(let i = 0; i < expired; i++)
            this.uncleblock.shift();
    }

    async appendSequencedBatch(batchId, batch, prevStateRoot, postStateRoot, txRoot) {
        console.log(`Calling function appendSequencedBatch for batch Id : ${batchId}`);
        let faulty = false;
        // malicious act of sequencer. (for testing)
        if (this.maliciousIds.includes(batchId)) {
            postStateRoot = prevStateRoot;
            logWarn(`Sequencer acting maliciously at batch ${batchId}`);
            faulty = true;
        }

        console.log(` pre-state root: ${prevStateRoot}`);
        console.log(` post-state root: ${postStateRoot}`);
        console.log(` tx root: ${txRoot}`);
        console.log(` batch : ${batch}`);

        try {
            const options = { value: this.fidelityBond };
            const tx = await this.contract.appendSequencerBatch(batchId,
                batch,
                prevStateRoot,
                postStateRoot,
                txRoot,
                options);
            const receipt = await tx.wait();
            if (receipt.status == 1) {
                logInfo("Sequenced batch appended successfully.");
                // remove faulty block from the malicious list.
                if (faulty) {
                    this.maliciousIds.shift();
                }
                const blocktime = (await this.provider.getBlock(receipt.blockNumber)).timestamp;
                // convert blocktime to milliseconds
                this.txblocktimestamp = blocktime * 1000;
                console.log("block time stamp : ", this.txblocktimestamp);
            } else {
                assert(0, "Error: receipt.status = 0");
            }
        } catch (error) {
            // production note: A tx could fail due to other reasons which are not all
            // thoroughly considered/handled here.
            logError(`Sequencer batch append call for batch id ${this.batchId} failed.`);
            logWarn(` ${error['error']['reason']}`);

            // update batch id with the batch id in smart contract.
            // await this.updateBatchId();
            return false;
        }
        return true;
    }

    async statechainUpdate() {
        await this.semaphore.acquire();
        console.log("state commitment chain updating.");
        try {
            const tx = await this.contract.cleanStateComChain();
            const receipt = await tx.wait();
            if (receipt.status == 1) {
                await this.updateLocalBatchChains();
            } else {
                assert(0, "Error: receipt.status = 0");
            }
            // update transaction statuses locally for finality.
            this.updateBatchFinality();
            // clean expired transactions from the txMap.
            this.cleanStorage();
            logInfo("state commitment chain update completed.");
        } catch (error) {
            logError("State commitment chain update failed.");
            logWarn(` ${error['error']['reason']}`);
        }
        this.semaphore.release();
    }

    getNonce(userAddress) {
        const user = this.stateMap.get(userAddress);
        if (user == undefined) {
            // user isn't a member. Nonce could be 1.
            return 1;
        } else {
            return user.nonce + 1;
        }
    }

    transactionLocalMng(eligible) {
        if (eligible) {
            this.setAcceptedinL2(this.tx);
            this.sequenceTx(this.tx);
            this.executedtxbatch.push(this.txref);
            logInfo(`${JSON.stringify(this.txref)} ACCEPTED_IN_L2`);
        } else {
            // rejected txrefs are gathered and removed
            // periodically.
            this.uncleblock.push(this.txref);
            logError(`${JSON.stringify(this.txref)} REJECTED`);
        }
    }

    getProof(leaftx) {
        // extract related batch id
        const batchid = leaftx.batchid;
        // get batch location
        const batchloc = this.batchLoc(batchid);
        // get batch.
        const batchdata = this.posttxbatches[batchloc];
        if (this.posttxbatches[batchloc] == undefined) {
            return {
                success: false,
                errormsg: `batch id : ${batchid} not found for batch location ` +
                    `${batchloc} in post transactions`
            }
        }
        // create leaves for merkle tree creation.
        let leaves = [];
        let leaf = undefined;
        let leafloc = undefined;
        for (let i = 0; i < batchdata.length; i++) {
            const tx = this.txMap.get(batchdata[i].id);
            leaves.push([tx.sender,
            tx.target,
            tx.type,
            String(tx.value),
            String(tx.nonce),
            String(tx.timestamp),
            tx.id
            ]);
            if (leaftx.id == tx.id) {
                leaf = tx;
                leafloc = i;
            }
        }
        if (leafloc == undefined) {
            return {
                success: false,
                errormsg: "transaction is not found in the batch"
            }
        }

        const mtree = createTrasactionMerkleTree(leaves);
        assert(mtree);
        const proof = mtree.getProof(leafloc);
        return {
            success: true,
            proof: proof,
            batchid: batchid,
            leaf: {
                sender: leaf.sender,
                target: leaf.target,
                type: leaf.type,
                value: leaf.value.toString(),
                nonce: leaf.nonce,
                timestamp: leaf.timestamp,
                id: leaf.id
            }
        };
    }

    generateWithdrawalProof(txid) {
        const tx = sequencer.txMap.get(txid);
        if (tx == undefined) {
            return {
                success: false,
                errormsg: `Transaction not found for id ${txid}`
            }
        }
        // proofs are only for withdrawals.
        if (tx.type != 'withdraw') {
            return {
                success: false,
                errormsg: "Transaction is not a withdrawal"
            };
        }
        if (tx.status == l2Status.REJECTED) {
            return {
                success: false,
                errormsg: "Transaction has been rejected by the Sequencer"
            };
        } else if (tx.status == l2Status.PENDING ||
            tx.status == l2Status.ACCEPTED_IN_L1 ||
            tx.status == l2Status.ACCEPTED_IN_L2) {
            return {
                success: false,
                errormsg: "Transaction is yet to be finalized"
            };
        } else if (tx.status == l2Status.FINALIZED) {
            return this.getProof(tx);
        } else {
            return {
                success: false,
                errormsg: "Unknow transaction status"
            };
        }
    }

    /**
     * Deposit L1 to L2.
     * Deposit balances according to the emitted events 
     * in the L1. Here `tx.sender` and `tx.target` addresses are equal.
     */
    deposit() {
        assert(this.txref);
        assert(this.tx);
        const sender = this.stateMap.get(this.tx.sender);
        let eligible = true;
        if (this.tx.value == undefined) {
            this.tx.status = l2Status.REJECTED;
            eligible = false;
        }

        if (eligible) {
            if (sender == undefined) {
                // user is not a member.
                let userdata = {
                    'balance': BigInt(this.tx.value),
                    'nonce': 0
                };
                this.stateMap.set(this.tx.sender, userdata);
            } else {
                sender.balance = BigInt(sender.balance) + BigInt(this.tx.value);
            }
        }
        // transaction management.
        this.transactionLocalMng(eligible);
    }

    /**
     * L2transfers
     * peer-to-peer transactions in l2.
     */
    l2transfer() {
        assert(this.txref);
        assert(this.tx);
        const sender = this.stateMap.get(this.tx.sender);
        const target = this.stateMap.get(this.tx.target);
        console.log("sender is :-", sender);
        console.log("target is:- ", target)
        let eligible = true;
        // sender should be in L2.
        if (sender == undefined) {
            this.tx.status = l2Status.REJECTED;
            this.tx.errormsg = "sender is not available in l2";
            eligible = false;
        }
        // enough account balance to execute tx.
        if (eligible && BigInt(sender.balance) < BigInt(this.tx.value)) {
            this.tx.status = l2Status.REJECTED;
            this.tx.errormsg = "not enough balance to execute the transaction";
            eligible = false;
        }
        // check nonce.
        if (eligible && sender.nonce + 1 != this.tx.nonce) {
            this.tx.status = l2Status.REJECTED;
            this.tx.errormsg = `incompatible nonce, expected ${sender.nonce + 1}`;
            eligible = false;
        }

        console.log("l2transfer Error message :- ", this.tx.errormsg);

        if (eligible) {
            // update target
            if (target == undefined) {
                let userdata = {
                    'balance': BigInt(this.tx.value),
                    'nonce': 0
                };
                this.stateMap.set(this.tx.target, userdata);
            } else {
                target.balance = BigInt(target.balance) + BigInt(this.tx.value);
            }
            // update sender
            sender.balance = BigInt(sender.balance) - BigInt(this.tx.value);
            sender.nonce += 1;
        }
        // transaction management.
        this.transactionLocalMng(eligible);
    }

    /**
     * L2 withdrawal
     * peer-to-peer transaction.
     * L2 withdrawal updates the statemap in l2
     * user will then make a l1withdraw to the l1.
     */ 
    withdraw() {
        assert(this.txref);
        assert(this.tx);
        const sender = this.stateMap.get(this.tx.sender);
        let eligible = true;

        // sender should be in L2.
        if (sender == undefined) {
            this.tx.status = l2Status.REJECTED;
            this.tx.errormsg = "sender is not available in l2";
            eligible = false;
        }
        // enough account balance to execute tx.
        if (eligible && BigInt(sender.balance) < BigInt(this.tx.value)) {
            this.tx.status = l2Status.REJECTED;
            this.tx.errormsg = "not enough balance to execute the transaction";
            eligible = false;
        }
        // check nonce.
        if (eligible && sender.nonce + 1 != this.tx.nonce) {
            this.tx.status = l2Status.REJECTED;
            this.tx.errormsg = `incompatible nonce, expected ${sender.nonce + 1}`;
            eligible = false;
        }

        if (eligible) {
            sender.balance = BigInt(sender.balance) - BigInt(this.tx.value);
            sender.nonce += 1;
        }
        // transaction management.
        this.transactionLocalMng(eligible);
    }

    /**
     * compress a batch of transactions.
     * first data is encoded and then compressed.
     */
    compressBatch(batch) {
        const compAlgorithm = 'pako';
        const abiEncodedData = this.abicoder.encode(["tuple(address _sender, address _target, string _type," +
            " uint256 _value, uint256 _nonce, uint256 _timestamp, uint256 _txid)[] _txLog"],
            [batch]);
        console.log("Batch encoded successfully.");
        console.log(`Encoded Batch : ${abiEncodedData}`);

        if (compAlgorithm == 'pako') {
            const input = new Uint8Array(
                new TextEncoder().encode(abiEncodedData));
            console.log("Batch uint8 : ", input);
            console.log("batch size : ", input.length);
            // data compression.
            const compressed = pako.deflateRaw(input, { level: 9 });
            console.log("compressed size : ", compressed.length);

            // calculate compression ratio
            console.log("compression Ratio (%) : ", compressed.length / abiEncodedData.length * 100.0);

            // convert compressed data to hex string
            const compressed_hex = Array.from(compressed).map((b) => b.toString(16).padStart(2, "0")).join("");
            console.log("Compressed data : ", compressed_hex);

            console.log("Estimated Fee Savings : ",
                estimate_fee_savings(abiEncodedData.substring(2), compressed_hex));
            return compressed;
        } else if (compAlgorithm == 'brotli') {
            return brotli.compress(Buffer.from(abiEncodedData));
        } else {
            assert(0, "Undefined compression algorithm");
        }
        return undefined;
    }

    /**
     * sequence the transaction into a batch.
     */
    sequenceTx(tx) {
        this.sequencedTransactionBatch.push([tx.sender,
        tx.target,
        tx.type,
        String(tx.value),
        String(tx.nonce),
        String(tx.timestamp),
        tx.id]);
    }

    /**
     * set the maximum no of transactions allowed in a single batch.
     * It could be either this.maxtransactions or the queue length.
     * @returns batchLimit number of batches per sequence.
     */
    setBatchLimit() {
        if (this.queue.length < this.maxtransactions) {
            return this.queue.length;
        }
        return this.maxtransactions;
    }

    /**
     * clear out all variables before a new sequence.
     */
    clearBatchdata() {
        this.sequencedTransactionBatch = [];
        this.executedtxbatch = [];
        this.txref = undefined;
        this.tx = undefined;
        this.txblocktimestamp = undefined;
        this.prevStateRoot = undefined;
        this.postStateRoot = undefined;
        this.txRoot = undefined;
    }

    preSequenceRun() {
        console.log("pre-sequence run starting.");
        // clear batch related arrays for new batching.
        this.clearBatchdata();

        // add prestate to pre-state list.
        this.prestates.push(JSON.stringify(Array.from(this.stateMap),
            (key, value) =>
                typeof value === 'bigint'
                    ? value.toString()
                    : value));
        this.prevStateRoot = creatStateMerkleTree(this.stateMap).root;
        assert(this.prevStateRoot, "undefined prev-state root.");
        console.log("balances: ", this.stateMap);
        console.log("pre-sequence run sucessfully executed.");
    }

    async postSequenceRun() {
        logInfo("post-sequence run starting.");
        if (!this.sequencedTransactionBatch.length) {
            logError("No transactions for sequencing.");
            logError('post-sequence run terminated.');
            return false;
        }
        console.log("end balances: ", this.stateMap);
        // create state tree.
        this.postStateRoot = creatStateMerkleTree(this.stateMap).root;
        assert(this.postStateRoot, "undefined post-state root.");

        // create transaction tree.
        this.txRoot = createTrasactionMerkleTree(this.sequencedTransactionBatch).root;
        assert(this.txRoot, "undefined transaction root.");

        // compress transaction batch.
        const compressedBath = this.compressBatch(this.sequencedTransactionBatch);
        console.log("Batch compressed sucessfully.");

        console.log("Sequencer post state root : ", this.postStateRoot);
        console.log("Sequncened tx root: ", this.txRoot);
        // append batch to layer 1.
        const appendDone = await this.appendSequencedBatch(this.batchId,
            compressedBath,
            this.prevStateRoot,
            this.postStateRoot,
            this.txRoot);

        if (appendDone) {
            this.acceptBatchinL1(this.executedtxbatch);
            this.batchId++;
            logInfo("post-sequence run sucessfully executed.");
            logInfo(`Time (sec): ${Math.floor(Date.now() / 1000)}`);
        } else {
            // re-queue executed transaction batch back to the queue.
            this.reQueue(this.executedtxbatch);
            // re-establish state-map to previous batch post-state.
            this.stateMap = new Map(JSON.parse(this.prestates.pop()));
            logError('post-sequence run terminated.');
        }
    }

    async sequence() {
        if (this.queue.length) {
            await this.semaphore.acquire();
            this.preSequenceRun();
            console.log("Queue Length : ", this.queue.length);
            const batchLimit = this.setBatchLimit();
            for (let i = 0; i < batchLimit; i++) {
                this.txref = this.queue.shift();
                this.tx = this.txMap.get(this.txref.id);
                console.log(this.txref);
                console.log(this.tx);
                if (this.txref.type == 'deposit') {
                    this.deposit();
                } else if (this.txref.type == 'l2transfer') {
                    this.l2transfer();
                } else if (this.txref.type == 'withdraw') {
                    this.withdraw();
                } else {
                    assert(0, "Undefined l2 transaction type.");
                }
            }
            await this.postSequenceRun();
            this.semaphore.release();
        } else {
            logWarn("No sequencing due to an empty queue.");
        }
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
            const decodedArgs = this.iface.decodeFunctionData(tx.data.slice(0, 10), tx.data);

            // decode function name called.
            const functionName = this.iface.getFunction(tx.data.slice(0, 10)).name;

            // event trigers.
            if (event.event == 'Deposited') {
                // nonce is not applicable for deposits.
                let nonce = 0;
                const l2tx = createTransaction(this.txid++, tx.from, tx.from, 'deposit', tx.value, nonce);
                this.txMap.set(l2tx.id, l2tx);
                this.queue.push({ id: l2tx.id, type: l2tx.type, timestamp: l2tx.timestamp });
            } else if (event.event == 'InvalidBatch') {
                console.log("Invaild batch detected at batch : ", event.returnValues['_batchId']);
                this.reBatch(Number(event.returnValues['_batchId']));
            }
        })
        const dateInSecs_end = new Date().getTime();
        const elapsed = dateInSecs_end - dateInSecs_start;
        console.log(`Elapsed time ${elapsed}`);
        this.semaphore.release();
    }
}

// state params
const sequencer = new Sequencer();
// test malicious sequencing at batch 1,3,5.
// sequencer.actMaliciousAt(1);
sequencer.actMaliciousAt(2);
// sequencer.actMaliciousAt(5);


function callSequence() {
    if (!sequencer.isBusy)
        sequencer.sequence();
}

function callChainUpdate() {
    if (!sequencer.isBusy)
        sequencer.statechainUpdate();
}

function listner() {
    if (!sequencer.isBusy)
        sequencer.listner();
}

eventEmitter.on('sequence', callSequence);
setInterval(() => { eventEmitter.emit('sequence'); }, 50000);

eventEmitter.on('chainUpdate', callChainUpdate);
setInterval(() => { eventEmitter.emit('chainUpdate'); }, 150000);

eventEmitter.on('listen', listner);
setInterval(() => { eventEmitter.emit('listen'); }, 60000);

app.listen(process.env.SEQUENCER_PORT, () => {
    console.log(`Sequencer is running on port ${process.env.SEQUENCER_PORT}`);
});

app.post('/getstatemap', async (req, res) => {
    await sequencer.semaphore.acquire();
    // grab the parameters from the front-end here
    const body = req.body;
    console.log(`Verifier pre-state fetch for batch ${body.batchId}`);
    assert(sequencer.prestates.length, "Empty pre-states");
    res.send(sequencer.getPrestate(body.batchId));
    sequencer.semaphore.release();
});

app.post('/getbalance', async (req, res) => {
    await sequencer.semaphore.acquire();
    const body = req.body;
    console.log(`user balance fetching for ${body.address}`);
    try {
        const data = sequencer.stateMap.get(body.address);
        if (data != undefined) {
            let balance = data.balance.toString();
            res.send({ balance: balance });
        } else {
            res.send({ balance: 0 });
        }
    } catch (error) {
        res.status = 500;
        res.send({ error: true, errormsg: error.message });
    }
    sequencer.semaphore.release();
})

app.post('/l2transfer', async (req, res) => {
    await sequencer.semaphore.acquire();
    const body = req.body;
    console.log(`user l2 transfer received`);

    try {
        const sender = recoverSender(body.signature,
            body.target,
            body.value,
            body.nonce,
            body.recoveryBit);

        // create rollup transaction.
        const l2tx = createTransaction(sequencer.txid++,
            getAddress(sender), //checksum address
            body.target,
            'l2transfer',
            BigInt(body.value),
            body.nonce);
        sequencer.txMap.set(l2tx.id, l2tx);
        sequencer.queue.push({ id: l2tx.id, type: l2tx.type, timestamp: l2tx.timestamp });
        res.send({ success: true, id: l2tx.id });
    } catch (error) {
        res.status = 500;
        res.send({ success: false, errormsg: error.message });
    }
    sequencer.semaphore.release();
})

app.post('/l2withdraw', async (req, res) => {
    await sequencer.semaphore.acquire();
    const body = req.body;
    console.log(`user l2 withdraw from ${body.sender}`);
    try {
        const sender = recoverSender(body.signature,
            body.target,
            body.value,
            body.nonce,
            body.recoveryBit);

        const l2tx = createTransaction(sequencer.txid++,
            getAddress(sender), //checksum address
            body.target,
            'withdraw',
            BigInt(body.value),
            body.nonce);
        sequencer.txMap.set(l2tx.id, l2tx);
        sequencer.queue.push({ id: l2tx.id, type: l2tx.type, timestamp: l2tx.timestamp });
        res.send({ success: true, id: l2tx.id });
    } catch (error) {
        res.status = 500;
        res.send({ sucess: false, errormsg: error.message });
    }
    sequencer.semaphore.release();
})

app.post('/getstatus', async (req, res) => {
    await sequencer.semaphore.acquire();
    const body = req.body;
    console.log(`transaction status fetching for tx id ${body.txid}`);
    try {
        const txData = sequencer.txMap.get(Number(body.txid));
        // serialize data for BigInt.
        if (txData) {
            const serData = JSON.stringify(txData,
                (key, value) =>
                    typeof value === 'bigint'
                        ? value.toString()
                        : value)
            res.send({
                success: true,
                txdata: serData
            });
        } else {
            res.send({
                success: false,
                errormsg: "Transaction is not found in the sequencer memory pool"
            });
        }
    } catch (error) {
        res.status = 500;
        res.send({ error: true, errormsg: error.message });
    }
    sequencer.semaphore.release();
})

app.post('/getproof', async (req, res) => {
    await sequencer.semaphore.acquire();
    const body = req.body;
    console.log(`withdrawal proof fetching for tx id ${body.txid}`);
    try {
        const proofData = sequencer.generateWithdrawalProof(Number(body.txid));
        console.log("proof : ", proofData);
        if (!proofData.success) {
            res.send({
                success: proofData.success,
                errormsg: proofData.errormsg
            });
        } else {
            res.send({
                success: proofData.success,
                proof: proofData.proof,
                batchid: proofData.batchid,
                leaf: proofData.leaf
            });
        }
    } catch (error) {
        res.status = 500;
        res.send({ success: false, errormsg: error.message });
    }
    sequencer.semaphore.release();
})
