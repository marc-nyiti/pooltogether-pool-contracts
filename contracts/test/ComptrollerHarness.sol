pragma solidity ^0.6.4;

import "../comptroller/Comptroller.sol";

/* solium-disable security/no-block-members */
contract ComptrollerHarness is Comptroller {

  uint256 internal time;

  function setCurrentTime(uint256 _time) external {
    time = _time;
  }

  function _currentTime() internal override view returns (uint256) {
    if (time == 0) {
      return block.timestamp;
    }
    return time;
  }

}