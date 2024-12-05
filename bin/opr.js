#!/usr/bin/env node
const { program } = require('commander');
const contractAddr = process.env.LOCALHOST_CONTRACT_ADDRESS;
const contractName = "OPR_Contract";
const axios = require('axios');
const hre = require('hardhat');
const { ethers } = require('hardhat');
const fs = require('fs');
const secp = require('ethereum-cryptography/secp256k1');
const { keccak256 } = require('ethereum-cryptography/keccak.js');
const { toHex, utf8ToBytes } = require('ethereum-cryptography/utils.js');
const { error } = require('console');

const sequencerurl = `http://localhost:${process.env.SEQUENCER_PORT}`;

class User {
    constructor() {
        this.contractaddress = process.env.LOCALHOST_CONTRACT_ADDRESS;
        this.contractabipath = process.env.CONTRACT_ABI_PATH + process.env.CONTRACT_ABI_FILE_NAME;
        this.privateKey = process.env.TESTNET_PRIVATE_KEY;

        this.provider = new ethers.providers.JsonRpcProvider(process.env.LOCALHOST_HTTP_URL);
        this.abicoder = ethers.utils.defaultAbiCoder;
        this.contractabi = this.readabi();

        this.contract = undefined;
        this.signer = undefined;

        this.wallet = {}

        this.leafEncode = "tuple(address sender, address target, " +
            "string type, uint256 value, uint256 nonce, uint256 timestamp, uint256 id) _leaf"
    }

    readabi() {
        let contractABI;
        try {
            contractABI = JSON.parse(fs.readFileSync(this.contractabipath)).abi;
        } catch (error) {
            console.log("unable to open file")
            console.error(error.message);
            process.exit();
        }
        return contractABI;
    }

    loadData() {
        try {
            const fileContents = fs.readFileSync('./bin/wallet.json', 'utf-8');
            this.wallet = JSON.parse(fileContents);
            // console.log('Loaded data from file:', this.data);
        } catch (err) {
            console.log('Error loading data from file:', err.message);
        }
    }

    saveData() {
        try {
            fs.writeFileSync('./bin/wallet.json', JSON.stringify(this.wallet));
        } catch (err) {
            console.log('Error saving data to file:', err.message);
        }
    }

    adduser(key, privateKey) {
        if (this.wallet[key]) {
            console.warn(`key ${key} is already available in the wallet. Either remove already` +
                ` available key first or use another key.`);
        } else {
            const signer = new ethers.Wallet(privateKey, this.provider);
            this.wallet[key] = {
                "privateKey": signer.privateKey,
                "nonce": 0,
                "address": signer.address
            }
            console.log(`user key ${key} added successfully in the wallet`);
            console.log(`Added key '${key}' with privatekey '${privateKey}'`);
        }
    }

    setContract(privateKey) {
        this.signer = new ethers.Wallet(privateKey, this.provider);
        this.contract = new ethers.Contract(this.contractaddress, this.contractabi, this.signer);
    }

    checkUser(key) {
        if (this.wallet[key]) {
            this.setContract(this.wallet[key].privateKey);
            return true;
        } else {
            console.log(`key ${key} not found in the wallet`)
            return false;
        }
    }

    messageHash(target, value, nonce) {
        return keccak256(utf8ToBytes(JSON.stringify({
            target: target,
            value: value,
            nonce: nonce
        })));
    }

    async l1deposit(key, ether) {
        const success = this.checkUser(key);
        if (success) {
            const tx_1 = await user.contract.deposit({ value: ethers.utils.parseEther(ether) });
            const receipt_1 = await tx_1.wait();
            console.log(receipt_1);
        } else {
            console.log("l1 deposit failed");
        }
    }

    async getl1Balance(key) {
        if (this.wallet[key].address) {
            const address = this.wallet[key].address;
            const balance = await this.provider.getBalance(address);
            // console.log("L1 Balance (wei) : ", balance.toString());
            console.log("L1 Balance (eth) : ", ethers.utils.formatEther(balance));
        } else {
            console.log(`key or address not available in the wallet`);
        }
    }

    async getl2Balance(key) {
        const address = this.wallet[key].address;
        if (address) {
            const { data: balance } = await axios.post(`${sequencerurl}/getbalance`, {
                address: address
            });
            // console.log("L2 Balance (wei) : ", balance.balance.toString());
            console.log("L2 Balance (eth) : ", ethers.utils.formatEther(balance.balance));
        } else {
            console.log(`address ${address} is not found`);
        }
    }

    async l2transfer(key, target, value, nonce) {
        const address = this.wallet[key].address;
        if (address) {
            // parse value
            value = ethers.utils.parseEther(value).toString();
            //sign message
            const [signature, recoveryBit] = await secp.sign(
                this.messageHash(target, value, nonce),
                this.wallet[key].privateKey.substring(2),
                { recovered: true });
            // send to sequencer
            const { data: tx } = await axios.post(`${sequencerurl}/l2transfer`, {
                signature: toHex(signature),
                target: target,
                value: value,
                nonce: nonce,
                recoveryBit: recoveryBit
            });
            if (tx.success) {
                console.log("tx reference : ", tx.id);
            } else {
                console.log("transaction failed.");
                console.log(`Error Message: ${tx.errormsg}`);
            }
        } else {
            console.log(`address ${address} is not found`);
        }
    }

    async l2withdraw(key, value, nonce) {
        const address = this.wallet[key].address;
        if (address) {
            // parse value
            value = ethers.utils.parseEther(value).toString();
            //sign message
            const [signature, recoveryBit] = await secp.sign(
                this.messageHash(address, value, nonce),
                this.wallet[key].privateKey.substring(2),
                { recovered: true });
            // send to sequencer
            const { data: tx } = await axios.post(`${sequencerurl}/l2withdraw`, {
                signature: toHex(signature),
                target: address,
                value: value,
                nonce: nonce,
                recoveryBit: recoveryBit
            });
            if (tx.success)
                console.log("tx reference : ", tx.id);
            else {
                console.log("transaction failed.");
                console.log(`Error Message: ${tx.errormsg}`);
            }
        } else {
            console.log(`address ${address} is not found`);
        }
    }

    l2status(status) {
        const l2txstatus = [
            'PENDING',
            'ACCEPTED_IN_L2',
            'ACCEPTED_IN_L1',
            'FINALIZED',
            'REJECTED',
            'NONE'
        ]
        return l2txstatus[status];
    }

    l2error(tx) {
        if (tx.errormsg) {
            console.log(`Error Message: ${tx.errormsg}`);
        }
    }

    async gettxStatus(id) {
        try {
            const { data: tx } = await axios.post(`${sequencerurl}/getstatus`, {
                txid: id
            })
            if (tx.success) {
                const txdata = JSON.parse(tx.txdata);
                console.log(JSON.parse(tx.txdata));
                console.log("l2 transaction status : ", this.l2status(txdata.status));
                this.l2error(txdata);
            } else {
                console.log(tx.errormsg);
            }
        } catch (error) {
            console.log(error);
        }
    }

    async gettxProof(id) {
        try {
            const { data: tx } = await axios.post(`${sequencerurl}/getproof`, {
                txid: id
            });
            if (tx.success) {
                const proofData = {
                    proof: tx.proof,
                    leaf: tx.leaf,
                    batchid: tx.batchid
                }
                return proofData;
            } else {
                console.log(tx.errormsg);
                return false;
            }
        } catch (error) {
            console.log(error);
        }
    }

    async l1withdraw(key, id) {
        const success = this.checkUser(key);

        // todo: check tx status.

        if (success) {
            const proofdata = await this.gettxProof(id);
            if (proofdata) {
                console.log("proof : ", proofdata.proof);
                console.log("batchid : ", proofdata.batchid);
                console.log("leaf : ", proofdata.leaf);

                const leaf = this.abicoder.encode([this.leafEncode],
                    [proofdata.leaf]);
                const tx_1 = await user.contract.withdraw(proofdata.proof,
                    leaf,
                    proofdata.batchid,
                    id);
                const receipt_1 = await tx_1.wait();
                console.log(receipt_1);
            }
        } else {
            console.log("l1 withdraw failed");
        }
    }
}

const user = new User();

process.on('exit', () => { user.saveData() });
program.description("optimistic rollup prototype user wallet")

program
    .command('add <key> <privateKey>')
    .description('Add a key and a private key to the wallet')
    .action((key, privateKey) => {
        user.adduser(key, privateKey);
    });

program
    .command('show')
    .description('Show wallet data')
    .action(() => console.log(user.wallet))

program
    .command('l1deposit <key> <ether>')
    .description('Desposit ether in Ethereum blockchain (L1).')
    .action((key, ether) => {
        user.l1deposit(key, ether);
    })

program
    .command('l1balance <key>')
    .description('Get l1 balance')
    .action((key) => {
        user.getl1Balance(key);
    })

program
    .command('l2balance <key>')
    .description('Get l2 balance')
    .action((key) => {
        user.getl2Balance(key);
    })

program
    .command('l2transfer <key> <target> <value> <nonce>')
    .description('Submit l2 transaction to the sequencer')
    .action((key, target, value, nonce) => {
        user.l2transfer(key, target, value, nonce);
    })

program
    .command('l1withdraw <key> <id>')
    .description('Withdraw ether in Ethereum blockchain (L1)')
    .action((key, id) => {
        user.l1withdraw(key, id);
    })

program
    .command('l2withdraw <key> <value> <nonce>')
    .description('Submit l2 withdraw to the sequencer')
    .action((key, value, nonce) => {
        user.l2withdraw(key, value, nonce);
    })

program
    .command('l2status <id>')
    .description('Get transaction Status')
    .action((id) => {
        user.gettxStatus(id);
    })

user.loadData();
program.parse(process.argv);
