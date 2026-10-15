// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Rally
/// @notice All-or-nothing crowdfunding in native BOT on BOT Chain.
///         A creator sets a goal and a deadline. Backers pledge BOT and can take
///         their pledge back any time before the deadline. If the goal is met by the
///         deadline the creator collects everything minus a small platform fee.
///         If it isn't (or the creator cancels), every backer gets a full refund.
///         All payouts are pull-based: amounts are credited, then withdrawn.
contract Rally is Ownable2Step, ReentrancyGuard, Pausable {
    struct Campaign {
        address creator;
        uint40 deadline;
        bool cancelled;
        bool claimed;
        uint128 goal;
        uint128 pledged;
        uint32 backers;
        string metadataURI;
    }

    uint16 public constant MAX_FEE_BPS = 300; // 3% hard cap
    uint40 public constant MIN_DURATION = 1 days;
    uint40 public constant MAX_DURATION = 90 days;

    uint16 public feeBps = 100; // 1% of a successful raise
    address public treasury;

    uint256 public campaignCount;
    mapping(uint256 => Campaign) private _campaigns;
    mapping(uint256 => mapping(address => uint256)) public pledgeOf;
    mapping(address => uint256) public balanceOf;

    event CampaignCreated(uint256 indexed id, address indexed creator, uint256 goal, uint256 deadline, string metadataURI);
    event Pledged(uint256 indexed id, address indexed backer, uint256 amount, uint256 total);
    event Unpledged(uint256 indexed id, address indexed backer, uint256 amount, uint256 total);
    event Claimed(uint256 indexed id, address indexed creator, uint256 toCreator, uint256 fee);
    event Refunded(uint256 indexed id, address indexed backer, uint256 amount);
    event Cancelled(uint256 indexed id);
    event Withdrawn(address indexed account, uint256 amount);
    event ConfigUpdated(uint16 feeBps, address treasury);

    error InvalidParams();
    error NotAuthorized();
    error CampaignEnded();
    error CampaignActive();
    error GoalNotMet();
    error GoalMet();
    error AlreadyDone();
    error NothingToWithdraw();
    error TransferFailed();

    constructor(address owner_, address treasury_) Ownable(owner_) {
        if (treasury_ == address(0)) revert InvalidParams();
        treasury = treasury_;
    }

    // ------------------------------------------------------------ campaigns

    function createCampaign(uint128 goal, uint40 duration, string calldata metadataURI)
        external
        whenNotPaused
        returns (uint256 id)
    {
        if (goal == 0 || duration < MIN_DURATION || duration > MAX_DURATION || bytes(metadataURI).length == 0) {
            revert InvalidParams();
        }
        id = ++campaignCount;
        Campaign storage c = _campaigns[id];
        c.creator = msg.sender;
        c.goal = goal;
        c.deadline = uint40(block.timestamp) + duration;
        c.metadataURI = metadataURI;
        emit CampaignCreated(id, msg.sender, goal, c.deadline, metadataURI);
    }

    function pledge(uint256 id) external payable nonReentrant whenNotPaused {
        Campaign storage c = _live(id);
        if (msg.value == 0) revert InvalidParams();
        if (pledgeOf[id][msg.sender] == 0) c.backers += 1;
        pledgeOf[id][msg.sender] += msg.value;
        c.pledged += uint128(msg.value);
        emit Pledged(id, msg.sender, msg.value, c.pledged);
    }

    /// @notice Take back some or all of your pledge while the campaign is running.
    function unpledge(uint256 id, uint256 amount) external nonReentrant {
        Campaign storage c = _live(id);
        uint256 mine = pledgeOf[id][msg.sender];
        if (amount == 0 || amount > mine) revert InvalidParams();
        pledgeOf[id][msg.sender] = mine - amount;
        if (mine == amount) c.backers -= 1;
        c.pledged -= uint128(amount);
        balanceOf[msg.sender] += amount;
        emit Unpledged(id, msg.sender, amount, c.pledged);
    }

    /// @notice Creator collects a successful campaign after its deadline.
    function claim(uint256 id) external {
        Campaign storage c = _get(id);
        if (msg.sender != c.creator) revert NotAuthorized();
        if (c.cancelled || c.claimed) revert AlreadyDone();
        if (block.timestamp < c.deadline) revert CampaignActive();
        if (c.pledged < c.goal) revert GoalNotMet();
        c.claimed = true;
        uint256 fee = (uint256(c.pledged) * feeBps) / 10_000;
        balanceOf[treasury] += fee;
        balanceOf[c.creator] += c.pledged - fee;
        emit Claimed(id, c.creator, c.pledged - fee, fee);
    }

    /// @notice Backer gets their pledge back if the campaign failed or was cancelled.
    function refund(uint256 id) external {
        Campaign storage c = _get(id);
        if (!c.cancelled) {
            if (block.timestamp < c.deadline) revert CampaignActive();
            if (c.pledged >= c.goal) revert GoalMet();
        }
        uint256 amount = pledgeOf[id][msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pledgeOf[id][msg.sender] = 0;
        balanceOf[msg.sender] += amount;
        emit Refunded(id, msg.sender, amount);
    }

    /// @notice Creator calls off a running campaign; every backer can refund.
    function cancel(uint256 id) external {
        Campaign storage c = _live(id);
        if (msg.sender != c.creator) revert NotAuthorized();
        c.cancelled = true;
        emit Cancelled(id);
    }

    /// @notice Withdraw everything credited to you. Never pausable.
    function withdraw() external nonReentrant {
        uint256 amount = balanceOf[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        balanceOf[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------ admin

    function setConfig(uint16 feeBps_, address treasury_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS || treasury_ == address(0)) revert InvalidParams();
        feeBps = feeBps_;
        treasury = treasury_;
        emit ConfigUpdated(feeBps_, treasury_);
    }

    /// @notice Pausing blocks new campaigns and pledges only. Unpledge, claim,
    ///         refund and withdraw always work.
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ------------------------------------------------------------ views

    function getCampaign(uint256 id) external view returns (Campaign memory) {
        return _campaigns[id];
    }

    // ------------------------------------------------------------ internals

    function _get(uint256 id) private view returns (Campaign storage c) {
        c = _campaigns[id];
        if (c.creator == address(0)) revert InvalidParams();
    }

    function _live(uint256 id) private view returns (Campaign storage c) {
        c = _get(id);
        if (c.cancelled) revert AlreadyDone();
        if (block.timestamp >= c.deadline) revert CampaignEnded();
    }
}
