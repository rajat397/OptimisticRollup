import fs from 'fs';
import Web3 from 'web3';
import 'dotenv/config';
import ethers from 'ethers';

class Listner {
    constructor() {
        this.web3providerurl = process.env.LOCALHOST_WEBSOCKET_URL;
        // for goerli : this.web3providerurl = process.env.AU_TESTNET_WEBSOCKET_URL;
        this.contractaddress = process.env.LOCALHOST_CONTRACT_ADDRESS;
        this.contractabipath = process.env.CONTRACT_ABI_PATH + process.env.CONTRACT_ABI_FILE_NAME;

        this.contractabi = this.readabi();

        this.web3 = new Web3( new Web3.providers.WebsocketProvider(this.web3providerurl));

        this.eventlistnercontract = new this.web3.eth.Contract(this.contractabi, this.contractaddress);

        this.iface = new ethers.utils.Interface(this.contractabi);

        this.abicoder = ethers.utils.defaultAbiCoder;
        // const latestBlock = await web3.eth.getBlock('latest');

        // block params
        this.fromblock = 0;
        this.blockinterval = 5;
        this.toblock = this.blockinterval - 1;
        this.listnercalls = 0;
        this.txid = 0;
    }

    readabi() {
        let contractABI;
        try{
            contractABI = JSON.parse(fs.readFileSync(this.contractabipath)).abi;
        }catch(error){
            console.log("unable to open file")
            console.error(error.message);
            process.exit();
        }
        return contractABI;
    }

    async getevents() {
        console.log(`listener call ${++this.listnercalls}`);
        console.log(`listening for ${this.fromblock} to ${this.toblock}`);

        let events = await this.eventlistnercontract.getPastEvents('allEvents',
                                                        {fromBlock: this.fromblock,
                                                         toBlock: this.toblock});

        console.log(`Total blocks listened : ${this.toblock}`);
        this.fromblock = this.toblock + 1;
        this.toblock += this.blockinterval;
        return events;
    }
}

export {Listner};