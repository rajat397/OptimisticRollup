// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;
import { Lib_utils } from "./Lib_utils.sol";

library challenge {

    /*****************************
     * layer 2 transaction types *
     *****************************/
    
    /**
     * @notice layer 2 deposit.
     * @param _target depositor (user).
     * @param _value deposit value.
     */
    function l2Deposit(Lib_utils.user memory _target, uint256 _value) internal pure {
        _target.amount += _value;
    }

    /**
     * @notice layer 2 user-to-user transfer.
     * @param _sender sender (user).
     * @param _target reciever (user).
     * @param _value transfer amount.
     * @param _nonce sender nonce.
     */
    function l2Transfer(Lib_utils.user memory _sender,
                        Lib_utils.user memory _target,
                        uint256 _value,
                        uint256 _nonce) internal pure {
        if(_sender.amount >= _value) {
            if(_sender.nonce + 1 == _nonce) {
                _sender.amount -= _value;
                _target.amount += _value;
                _sender.nonce += 1;
            }
        }
    }

    /**
     * @notice layer 2 withdrawal.
     * @param _target withdrawer (user).
     * @param _value withdrawal amount.
     * @param _nonce withdrawer nonce.
     */
    function l2Withdraw(Lib_utils.user memory _target, uint256 _value, uint256 _nonce) internal pure {
        if(_target.amount >= _value) {
            if(_target.nonce + 1 == _nonce) {
                _target.amount -= _value;
                _target.nonce += 1;
            }
        }
    }


    /**
     * user search in the users array.
     * @param _users users array consisits of all users.
     * @param _address address of the user.
     */
    function getUser(Lib_utils.user[] memory _users, address _address) internal pure returns (Lib_utils.user memory) {
        for(uint256 i = 0; i < _users.length; i++) {
            if(_users[i].account == _address) {
                return _users[i];
            }
        }
        revert("User not found.");
    }

    /**
     * @notice transaction execution against the world state.
     * @param _l2txs transaction batch.
     * @param _users user data (world state)
     */
    function transactionExecution(Lib_utils.l2transaction[] memory _l2txs, Lib_utils.user[] memory _users) internal pure {
        for(uint256 i = 0; i < _l2txs.length; i++) {
            if(keccak256(abi.encode(_l2txs[i].l2type)) == keccak256(abi.encode(string('deposit')))) {
                Lib_utils.user memory _target = getUser(_users, _l2txs[i].target);
                l2Deposit(_target, _l2txs[i].value);
            } else if(keccak256(abi.encode(_l2txs[i].l2type)) == keccak256(abi.encode(string('l2transfer')))) {
                Lib_utils.user memory _sender = getUser(_users, _l2txs[i].sender);
                Lib_utils.user memory _target = getUser(_users, _l2txs[i].target);
                l2Transfer(_sender, _target, _l2txs[i].value, _l2txs[i].nonce);
            } else if(keccak256(abi.encode(_l2txs[i].l2type)) == keccak256(abi.encode(string('withdraw')))) {
                Lib_utils.user memory _target = getUser(_users, _l2txs[i].target);
                l2Withdraw(_target, _l2txs[i].value, _l2txs[i].nonce);
            }
        }
    }

    function userInitialization(
        mapping (address => bool) storage userRegistry,
        Lib_utils.l2transaction[] memory _l2txs, 
        Lib_utils.user[] memory _users
        ) internal returns (Lib_utils.user[] memory) {
        // number of new users.
        uint newUserCount;

        // update user registry with users array.
        // 'users' array is an input given by the verifier.
        for(uint256 i = 0; i < _users.length; i++) {
            if(!userRegistry[_users[i].account]) {
                userRegistry[_users[i].account] = true;
            }
        }

        // count new users.
        for(uint256 j = 0; j < _l2txs.length; j++) {
            if(!userRegistry[_l2txs[j].target]) {
                newUserCount++;
            }
        }

        if(newUserCount > 0) {
            // collect new user addresses in an addresses array.
            address[] memory newUserAddrs = new address[](newUserCount);
            uint256 usidx = 0;
            for(uint256 k = 0; k < _l2txs.length; k++) {
                if(!userRegistry[_l2txs[k].target]) {
                    newUserAddrs[usidx] = _l2txs[k].target;
                    usidx++;
                }
            }

            // create new user structs for users.
            Lib_utils.user[] memory newUsers = new Lib_utils.user[](newUserCount);
            uint256 uniqueNewUsers;
            for(uint256 m = 0; m < newUserCount; m++) {
                if(!userRegistry[newUserAddrs[m]]) {
                    newUsers[m] = Lib_utils.user(newUserAddrs[m], 0, 0);
                    userRegistry[newUserAddrs[m]] = true;
                    uniqueNewUsers++;
                }
            }

            // append newusers to users array.
            Lib_utils.user[] memory updatedUsers = new Lib_utils.user[]((_users.length + uniqueNewUsers));
            for(uint256 n = 0; n < updatedUsers.length; n++) {
                if(n < _users.length) {
                    updatedUsers[n] = _users[n];
                } else {
                    updatedUsers[n] = newUsers[n - _users.length];
                }
            }
            return updatedUsers;
        }
        return _users;
    }
}