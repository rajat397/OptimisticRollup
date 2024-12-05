// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;
import "./inflateLib.sol";

library Lib_utils {

    /*******************
     * Data Structures *
     *******************/

    enum transactionType {
        deposit,
        l2transfer,
        withdraw
    }

    struct stateCommitments {
        bytes32 prevStateRoot;
        bytes32 postStateRoot;
        bytes32 txRoot;
        bytes32 txhash;
        uint256 finality;
    }

    struct user {
        address account;
        uint256 amount;
        uint256 nonce;
    }

    struct l2transaction {
        address sender;
        address target;
        string l2type;
        uint256 value; 
        uint256 nonce;
        uint256 timestamp;
        uint256 txid;
    }

    /************************
     * Data type covertions *
     ************************/
    
    /**
     * @notice utf-8 to hex character converter.
     * @param _a utf8 character.
     * @return b hex character.
     */
    function utf8ToHex(uint8 _a) internal pure returns (uint8 b) {
        if (_a >= 0x30 && _a <= 0x39) {
            // char 0-9
            b = uint8(_a - 0x30);
        } else if (_a >= 0x61 && _a <= 0x66) {
            // char a-f
            b = uint8(_a - 0x57);
        } else {
            revert(
                "Unbounded utf8 character."
            );
        }
    }

    /**
     * @notice decode utf8 string to hex string.
     * @param _utf8InputString input utf8 encoded string.
     * @return hexstring as a byte array.
     */
    function decodeutf8String(bytes memory _utf8InputString) internal pure returns (bytes memory) {
        bytes memory packed = new bytes(uint(_utf8InputString.length)/2 - 1);
        // should skip the '0x' at the beginning of the utf-8 encoded string.
        // Hence starting from 2nd and 3rd values of the input.
        for (uint i = 0; i < uint(packed.length); i++) {
            unchecked {
                packed[i] = bytes1(utf8ToHex(uint8(_utf8InputString[i * 2 + 2])) * 16
                                     + utf8ToHex(uint8(_utf8InputString[i * 2 + 3])));
            }
        }
        return abi.encodePacked(packed);
    }

    /**
     * @notice Data decompression in on-chain.
     * @param data compressed data stream.
     * @param length uncompressed data length.
     * @return ErrorCode if the decompression failed.
     * @return data uncompressed data stream.
     */
    function decompress (
        bytes calldata data,
        uint256 length
    ) internal pure returns (InflateLib.ErrorCode, bytes memory) {
        return InflateLib.puff(data, length);
    }

}