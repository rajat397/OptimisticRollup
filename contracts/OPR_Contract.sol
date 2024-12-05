// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "hardhat/console.sol";
import "./inflateLib.sol";
import { Lib_utils } from "./Lib_utils.sol";
import { Lib_MerkleTree } from "./Lib_MerkleTree.sol";
import { challenge } from "./challenge.sol";


contract OPR_Contract {
    event Deposited(address indexed _address, uint indexed _amount);
    event Withdrawal();
    event SequencedBatch(uint256 _batchId);
    event InvalidPreState();
    event InvalidPostState();
    event InvalidTxRoot();
    event InvalidBatch(uint256 _batchId);
    error AlreadyClaimed();
    error InvalidWithdrawalProof();


    bool reBatching;
    uint16 challengePeriod = 5 minutes;
    address public owner;

    uint256 public fidelityBond;
    uint256 public batchId;
    uint256 public batchoffset;
    mapping (address => bool) userRegistry;

    // This is a packed array of booleans.
    mapping(uint256 => uint256) private claimedBitMap;
    
    // state commitment chain
    Lib_utils.stateCommitments[] scc;

    constructor() {
        owner = msg.sender;
        fidelityBond = 10 ether;
    }

    /**
     * @notice deposit funds in L1 to be used in L2.
     * sequencer catches the Deposited event and credit funds in L2.
     */
    function deposit()  external payable {
        emit Deposited(msg.sender, msg.value);
    }

    /**
     * @notice check if a withdrawal transaction is claimed.
     * @param index transaction index.
     */
    function isClaimed(uint256 index) public view returns (bool) {
        uint256 claimedWordIndex = index / 256;
        uint256 claimedBitIndex = index % 256;
        uint256 claimedWord = claimedBitMap[claimedWordIndex];
        uint256 mask = (1 << claimedBitIndex);
        return claimedWord & mask == mask;
    }

    /**
     * @notice set withdrawal transaction claimed.
     * @param index transaction index.
     */
    function _setClaimed(uint256 index) private {
        uint256 claimedWordIndex = index / 256;
        uint256 claimedBitIndex = index % 256;
        claimedBitMap[claimedWordIndex] = claimedBitMap[claimedWordIndex] | (1 << claimedBitIndex);
    }

    /**
     * @notice append sequenced batch in on-chain.
     * @param _batchId batch index as a uint256.
     * @param _batch compressed batch data.
     * @param _preStateRoot pre-state root.
     * @param _postStateRoot post-state root.
     * @param _txRoot transaction root.
     */
    function appendSequencerBatch(
        uint _batchId,
        bytes calldata _batch,
        bytes32 _preStateRoot,
        bytes32 _postStateRoot,
        bytes32 _txRoot
    )
        external
        payable
        ownerOnly
    {
        // sequencer should adhere to the l1 batch id.
        require(batchId == _batchId, "Invalid batch Id for sequenced batch");

        // fidenlity bond requirement.
        require(msg.value >= fidelityBond, "Insufficient fidelity bond value");

        // check state-commitment-chain intergrity.
        // batch pre-state should be in consistence with pre-batch post state.
        // genesis block is skipped.
        uint256 batchIndex = _batchId - batchoffset;
        if(batchId > 0) {
            // we assume batchIndex can not reach to zero assuming continuous traffic
            // in the L2 chain. Hence _batchId is always much greater than the batch off set.
            // This shall be controlled by increasing the batch maturity condition. When the
            // maturity becomes longer batchoffset is increased slowly, but the in meantime sequencer
            // may have appended blocks in the state chain which leads to a healthy wider range between
            // batchId and batchoffset values.
            // If batch_index has become zero, we skip the intergirty check with the previous hash value for
            // now. Sequencer may still be acting honestly, keeping the post and pre state roots consistant
            // in adjacent blocks. But it is still a concern in terms of continuity of the chain. But it does
            // not breach the security of the rollup.
            if(batchIndex > 0) {
                require(scc[_batchId - batchoffset - 1].postStateRoot == _preStateRoot, "Inconsistent chain _preStateRoot");
            }
        }

        uint256 finality = block.timestamp + challengePeriod;
        scc.push(Lib_utils.stateCommitments(_preStateRoot,
                                _postStateRoot,
                                _txRoot,
                                keccak256(_batch),
                                finality));
        batchId++;
        reBatching = false;
        emit SequencedBatch(_batchId);
    }


    /**
     * @notice batch verification in L1.
     * @param _data compressed transaction data.
     * @param _userdata encoded statemap of the userdata.
     * @param _batchId batch id.
     * @param _length length of the uncompressed _data.
     */
    function verifyTransactions(
        bytes calldata _data,
        bytes calldata _userdata,
        uint _batchId,
        uint _length
    )
    external 
    payable
    {
        InflateLib.ErrorCode errorCode;
        bool errorDectected;
        uint256 blockIndex;
        Lib_utils.l2transaction[] memory l2txs;
        Lib_utils.user[] memory userdata;
        bytes memory txbatch;

        // need enough bonds to challenge.
        require(msg.value >= fidelityBond, "Insufficient fidelity bond value");

        // challenged batch should be already commited by the sequencer.
        require(_batchId < batchId, "Invalid batch Id for tx verification.");

        blockIndex = _batchId - batchoffset;
        require(block.timestamp <= scc[blockIndex].finality,
                "Challenge period is expired. Block has been finalized.");

        // check validity of the compressed data.
        require(scc[blockIndex].txhash == keccak256(_data), "Invalid tx batch hash.");

        // decompress the batch.
        (errorCode, txbatch) = Lib_utils.decompress(_data, _length);

        // check decompression status.
        require(errorCode == InflateLib.ErrorCode.ERR_NONE, "Error in data decompression.");

        // validate tx-root on-chain.
        // The decompressed data is in utf-8. It should be first converted to a
        // hex stream.
        l2txs = abi.decode(Lib_utils.decodeutf8String(txbatch), (Lib_utils.l2transaction[]));
        if (scc[blockIndex].txRoot != Lib_MerkleTree.getMerkleRoot(Lib_MerkleTree.genTransactionLeaves(l2txs))) {
            emit InvalidTxRoot();
            errorDectected = true;
        }

        if(!errorDectected) {
            // validate pre-state root on-chain.
            userdata = abi.decode(_userdata, (Lib_utils.user[]));
            if (scc[blockIndex].prevStateRoot != Lib_MerkleTree.getMerkleRoot(Lib_MerkleTree.genStateLeaves(userdata))) {
                emit InvalidPreState();
                errorDectected = true;
            }
        }

        if(!errorDectected) {
            // initialize user data for execution.
            userdata = challenge.userInitialization(userRegistry, l2txs, userdata);

            // transaction re-execution in l1.
            challenge.transactionExecution(l2txs, userdata);

            // validate post-state root on-chain.
            if (scc[blockIndex].postStateRoot != Lib_MerkleTree.getMerkleRoot(Lib_MerkleTree.genStateLeaves(userdata))) {
                emit InvalidPostState();
                errorDectected = true;
            }
        }

        // remove all entries after disputed batchId in the state chain.
        if(errorDectected) {
            // reabatching is expected by the sequencer.
            // starting from the updated batch id.
            // all other batch appends will be rejected.
            reBatching = true;

            // update next expected batch id.
            batchId = _batchId;

            uint256 scclen = scc.length;
            // remove blocks after the disputed block.
            for(uint256 i = blockIndex; i < scclen - 1; i++) {
                scc.pop();
                // send back bonds.
                payable(owner).transfer(fidelityBond);
            }

            // remove the disputed block.
            scc.pop();
            // verifier wins the challenge and get the refund.
            uint256 refund = 3 * fidelityBond / 2;
            payable(msg.sender).transfer(refund);
            // half of the sequencer bond will be slashed.
            payable(0x000000000000000000000000000000000000dEaD).transfer(fidelityBond / 2);

            emit InvalidBatch(_batchId);
        }
    }

    /**
     * @notice state-commitment-chain cleaner.
     * sequencer will periodically call this function to release matured
     * entries/blocks of the scc. when the block is older than x times the
     * challenge period, it shall be assumed users have already withdrawn
     * their funds in L1 and data is no longer needed to be preserved.
     */
    function cleanStateComChain() external {
        // state-commitment-chain alterations shall only be done
        // when there is no dispute over the commited blocks. When a 
        // verifier has sucessfully challenged a commited block, Chain
        // clearing or block rescheduling shall only be resumed after
        // a successful re-batching by the sequencer.
        // In this way we shall omit a batch mis-matching at sequencer end.
        require(!reBatching, "State chain modifications are altered until re-batching is done.");

        // @maturity will contain the total no of matured blocks 
        // based on the maturity condition. (eg. timestamp > 2 weeks)
        uint256 maturity;
        if(scc.length > 0) {
            for(uint256 i = 0; i < scc.length; i++) {
                if(block.timestamp > scc[i].finality + challengePeriod * 3) {
                    maturity++;
                } else {
                    break;
                }
            }
        }

        // if there are matured blocks,
        // rearrage and remove/pop the scc accordingly.
        if(maturity > 0) {
            // rearrange scc.
            for (uint256 j = maturity; j < scc.length; j++) {
                scc[j - maturity] = scc[j];
            }
            // remove additional items and refund fidelity bonds.
            for (uint256 k = 0; k < maturity; k++) {
                scc.pop();
                payable(owner).transfer(fidelityBond);
            }
            batchoffset += maturity;
        }
    }

    /**
     * @notice user fund withdraw in L1.
     * @param _txProof proof of transaction inclusion.
     * @param _leaf leaf transaction.
     * @param _batchId corresponding batch id of the leaf.
     * @param _txId transaction id.
     */
    function withdraw(bytes32[] calldata _txProof,bytes calldata _leaf, uint256 _batchId, uint256 _txId) external payable {
        uint256 blockIndex;
        Lib_utils.l2transaction memory l2tx;

        blockIndex = _batchId - batchoffset;

        require(!reBatching, "Withdrawals are altered until re-batching is done.");

        require(_batchId <= batchId, "Invalid BatchId for withdrawal verification");

        // user can only withdraw funds when the block has matured.
        require(block.timestamp > scc[blockIndex].finality,
                "Block has not been finalized yet.");

        // check if the withdrawal is already claimed.
        if (isClaimed(_txId)) revert AlreadyClaimed();

        l2tx = abi.decode(_leaf, (Lib_utils.l2transaction));
        bytes32 leafhash = keccak256(
                                bytes.concat(
                                    keccak256(
                                        abi.encode(
                                            l2tx.sender,
                                            l2tx.target,
                                            l2tx.l2type,
                                            l2tx.value,
                                            l2tx.nonce,
                                            l2tx.timestamp,
                                            l2tx.txid
                                        )
                                    )
                                )
                            );

        // check if a withdrawal transaction.
        if(keccak256(abi.encode(l2tx.l2type)) != keccak256(abi.encode(string('withdraw'))))
            revert InvalidWithdrawalProof();

        // verify leafhash.
        if (!MerkleProof.verify(_txProof, scc[blockIndex].txRoot, leafhash))
            revert InvalidWithdrawalProof();

        require(l2tx.target == msg.sender, "Withdrawal is only claimable by the asset owner");
        // Mark it claimed and send the token.
        _setClaimed(_txId);
        payable(msg.sender).transfer(l2tx.value);
        emit Withdrawal();
    }

    modifier ownerOnly {
        require(owner == msg.sender);
        _;
    }
}