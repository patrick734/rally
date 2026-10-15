// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Contract that refuses native transfers, to prove one bad recipient can't block others.
contract Rejecter {
    receive() external payable { revert("no"); }
    function call(address target, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory r) = target.call{value: msg.value}(data);
        require(ok, "call failed");
        return r;
    }
}
