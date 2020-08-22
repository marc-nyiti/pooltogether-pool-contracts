pragma solidity ^0.6.4;

import "@openzeppelin/contracts-ethereum-package/contracts/access/Ownable.sol";

import "../drip/BalanceDripManager.sol";
import "../drip/VolumeDripManager.sol";

contract ComptrollerStorage is OwnableUpgradeSafe {
  uint256 internal _reserveRateMantissa;

  // mapping(address => VolumeDripManager.State) internal volumeDrips;
  // mapping(address => VolumeDripManager.State) internal referralVolumeDrips;
  // mapping(address => BalanceDripManager.State) internal balanceDrips;

  mapping(address => MappedSinglyLinkedList.Mapping) internal sourceDripManagers;

  mapping(address => mapping(address => uint256)) internal dripTokenBalances;
}
