// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;
import { Lib_utils } from "./Lib_utils.sol";


library Lib_MerkleTree {

    /**
     * @notice generate hashed leaves for the merkle tree.
     * @param _users array of users with account details.
     * @return bytes32[] an array of hshed leaves.
     */
    function genStateLeaves(
        Lib_utils.user[] memory _users
    )
        internal
        pure 
        returns (
            bytes32[] memory
        ) 
    {
        bytes32[] memory elements = new bytes32[](_users.length);
        for (uint id = 0; id < _users.length; id ++) {
            elements[id] = keccak256(
                                bytes.concat(
                                        keccak256(
                                            abi.encode(
                                                _users[id].account,
                                                _users[id].amount,
                                                _users[id].nonce
                                                    )
                                                )
                                            )
                                    );
        }
        return elements;
    }

    /**
     * @notice generate hashed leaves for the merkle tree.
     * @param _l2txs array of transactions.
     * @return bytes32[] an array of hshed leaves.
     */
    function genTransactionLeaves(
        Lib_utils.l2transaction[] memory _l2txs
    )
        internal 
        pure 
        returns (
            bytes32[] memory
        )
    {
        bytes32[] memory elements = new bytes32[](_l2txs.length);
        for (uint id = 0; id < _l2txs.length; id ++) {
            elements[id] = keccak256(
                                bytes.concat(
                                        keccak256(
                                            abi.encode(
                                                    _l2txs[id].sender,
                                                    _l2txs[id].target,
                                                    _l2txs[id].l2type,
                                                    _l2txs[id].value, 
                                                    _l2txs[id].nonce,
                                                    _l2txs[id].timestamp,
                                                    _l2txs[id].txid
                                                    )
                                                )
                                            )
                                    );
        }
        return elements;
    }

    /**
     * @notice create a merkle tree from the hashed leaves.
     * @param _elements Array of hashes from which to generate a merkle root.
     * @return root root of the merkle tree.
     */
    function getMerkleRoot(bytes32[] memory _elements) internal pure returns (bytes32) {
        require(_elements.length > 0, "Lib_MerkleTree: Must provide at least one leaf hash.");

        if (_elements.length == 1) {
            return _elements[0];
        }

        // Number of non-empty nodes at the current depth.
        uint256 rowSize = _elements.length;

        // Common sub-expressions
        uint256 halfRowSize;         // rowSize / 2
        bool rowSizeIsOdd;           // rowSize % 2 == 1

        while (rowSize > 1) {
            halfRowSize = rowSize / 2;
            rowSizeIsOdd = rowSize % 2 == 1;

            for (uint256 i = 0; i < halfRowSize; i++) {
                _elements[i] = _hashPair(_elements[(2 * i)], _elements[(2 * i) + 1]);
            }

            if (rowSizeIsOdd) {
                _elements[0] = _hashPair(_elements[0], _elements[rowSize - 1]);
            }
            rowSize = halfRowSize;
        }
        return _elements[0];
    }

    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? _efficientHash(a, b) : _efficientHash(b, a);
    }

    function _efficientHash(bytes32 a, bytes32 b) private pure returns (bytes32 value) {
        /// @solidity memory-safe-assembly
        assembly {
            mstore(0x00, a)
            mstore(0x20, b)
            value := keccak256(0x00, 0x40)
        }
    }
}