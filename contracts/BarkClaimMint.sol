// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {BarkClaimPass} from "./BarkClaimPass.sol";

interface IB20Airdrop {
    function claim(address account, uint256 txCount, uint256 deadline, bytes calldata signature) external;
    function claimed(address account) external view returns (bool);
}

/**
 * Claiming BARK and minting the pass, in one transaction.
 *
 * REQUIRES that the already-deployed airdrop lets a third party call claim() on
 * behalf of `account`. Its signature takes `account` explicitly, which suggests it
 * does, but that must be confirmed against the deployed bytecode before this is
 * used — if it enforces msg.sender == account, this contract cannot work and the
 * mint has to be a separate transaction.
 *
 * Mint proceeds go to `treasury`, which is intended to be the wallet that seeds
 * the pool. Nothing here adds liquidity by itself; that is a manual step, so the
 * treasury address should be public and its movements verifiable.
 */
contract BarkClaimMint is Ownable, ReentrancyGuard {
    /// 70 BARK per Base transaction, matching the airdrop.
    uint256 public constant BARK_PER_TX = 70e18;

    /// A ceiling the owner cannot raise past, so "$0.10" can never quietly become "$10".
    uint256 public constant MAX_PRICE = 0.001 ether;

    IB20Airdrop public immutable airdrop;
    BarkClaimPass public immutable pass;

    address public treasury;
    uint256 public price;

    event PriceSet(uint256 price);
    event TreasurySet(address indexed treasury);
    event Claimed(address indexed account, address indexed payer, uint256 tokenId, uint256 paid);

    error PriceTooHigh();
    error Underpaid(uint256 sent, uint256 required);
    error AlreadyClaimed();
    error ZeroAddress();
    error TransferFailed();

    constructor(address owner_, IB20Airdrop airdrop_, BarkClaimPass pass_, address treasury_, uint256 price_)
        Ownable(owner_)
    {
        if (address(airdrop_) == address(0) || address(pass_) == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (price_ > MAX_PRICE) revert PriceTooHigh();
        airdrop = airdrop_;
        pass = pass_;
        treasury = treasury_;
        price = price_;
    }

    /// Price is in wei, so a USD target is held by updating it as ETH moves.
    function setPrice(uint256 price_) external onlyOwner {
        if (price_ > MAX_PRICE) revert PriceTooHigh();
        price = price_;
        emit PriceSet(price_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    /**
     * Pays for the pass, claims the airdrop for `account`, and mints the pass to it.
     *
     * The airdrop and the pass both land with `account`, not with whoever paid, so
     * covering someone else's claim gives them the tokens and the NFT.
     */
    function claimWithPass(address account, uint256 txCount, uint256 deadline, bytes calldata signature)
        external
        payable
        nonReentrant
        returns (uint256 tokenId)
    {
        uint256 required = price;
        if (msg.value < required) revert Underpaid(msg.value, required);
        if (airdrop.claimed(account)) revert AlreadyClaimed();

        // Reverts the whole transaction on a bad signature, expiry or empty allocation,
        // so nobody is ever charged for a claim that did not happen.
        airdrop.claim(account, txCount, deadline, signature);

        tokenId = pass.mint(account, uint64(txCount), uint128(txCount * BARK_PER_TX));
        emit Claimed(account, msg.sender, tokenId, required);

        uint256 refund = msg.value - required;
        if (required > 0) _send(treasury, required);
        if (refund > 0) _send(msg.sender, refund);
    }

    function _send(address to, uint256 value) private {
        (bool ok,) = payable(to).call{value: value}("");
        if (!ok) revert TransferFailed();
    }

    /// Nothing should accumulate here, but a forced transfer cannot be refused.
    function sweep() external onlyOwner {
        _send(treasury, address(this).balance);
    }
}
