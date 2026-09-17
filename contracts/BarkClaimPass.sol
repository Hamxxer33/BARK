// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface IB20Airdrop {
    function claimedAmount(address account) external view returns (uint256);
}

/**
 * The BARK Claim Pass.
 *
 * Minted just before a wallet claims its airdrop: the site sends this mint, then the
 * claim itself, as two transactions behind one button.
 *
 * Because the pass is minted first, the claim has not happened yet and there is no
 * amount to record — and taking one from the caller would let anyone mint themselves
 * the top tier. So nothing about the allocation is stored. The pass remembers who
 * minted it, and reads that wallet's claimed amount from the airdrop whenever it is
 * displayed. The number on the card is therefore always the real one, it stays with
 * the original claimant after the pass changes hands, and a wallet that mints without
 * ever claiming honestly shows nothing.
 *
 * Art and metadata are built in the contract. The project's pitch is that the
 * liquidity is locked forever, and an NFT whose image dies with an IPFS pin makes a
 * liar of that.
 */
contract BarkClaimPass is ERC721, Ownable {
    using Strings for uint256;

    /// Matches the airdrop: 70 BARK per Base transaction.
    uint256 public constant BARK_PER_TX = 70e18;

    /// A ceiling the owner cannot pass, so a ten-cent mint cannot quietly become ten dollars.
    uint256 public constant MAX_PRICE = 0.001 ether;

    IB20Airdrop public immutable airdrop;

    address public treasury;
    uint256 public price;
    uint256 public totalMinted;

    /// The wallet that minted each pass. Its claim is what the pass reports, even
    /// after the pass is sold on.
    mapping(uint256 => address) public claimant;
    mapping(uint256 => uint64) public mintedAt;
    /// One pass per wallet.
    mapping(address => uint256) public passOf;

    event PriceSet(uint256 price);
    event TreasurySet(address indexed treasury);
    event PassMinted(uint256 indexed tokenId, address indexed claimant, uint256 paid);

    error PriceTooHigh();
    error Underpaid(uint256 sent, uint256 required);
    error AlreadyMinted(uint256 tokenId);
    error ZeroAddress();
    error NoSuchToken();
    error TransferFailed();

    constructor(address owner_, IB20Airdrop airdrop_, address treasury_, uint256 price_)
        ERC721("BARK Claim Pass", "BARKPASS")
        Ownable(owner_)
    {
        if (address(airdrop_) == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (price_ > MAX_PRICE) revert PriceTooHigh();
        airdrop = airdrop_;
        treasury = treasury_;
        price = price_;
    }

    /* ----------------------------------------------------------------- mint */

    function mint() external payable returns (uint256 tokenId) {
        uint256 required = price;
        if (msg.value < required) revert Underpaid(msg.value, required);

        uint256 existing = passOf[msg.sender];
        if (existing != 0) revert AlreadyMinted(existing);

        tokenId = ++totalMinted;
        claimant[tokenId] = msg.sender;
        mintedAt[tokenId] = uint64(block.timestamp);
        passOf[msg.sender] = tokenId;
        _safeMint(msg.sender, tokenId);
        emit PassMinted(tokenId, msg.sender, required);

        if (required > 0) _send(treasury, required);
        uint256 refund = msg.value - required;
        if (refund > 0) _send(msg.sender, refund);
    }

    function _send(address to, uint256 value) private {
        (bool ok,) = payable(to).call{value: value}("");
        if (!ok) revert TransferFailed();
    }

    /* ---------------------------------------------------------------- admin */

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

    /// Nothing should collect here, but a forced transfer cannot be refused.
    function sweep() external onlyOwner {
        _send(treasury, address(this).balance);
    }

    /* ------------------------------------------------------------- metadata */

    /// Live from the airdrop, so it is the real figure rather than one supplied at mint.
    function claimedBy(uint256 tokenId) public view returns (uint256) {
        address who = claimant[tokenId];
        if (who == address(0)) return 0;
        try airdrop.claimedAmount(who) returns (uint256 amount) {
            return amount;
        } catch {
            return 0;
        }
    }

    function tierOf(uint256 amount) public pure returns (string memory) {
        uint256 txCount = amount / BARK_PER_TX;
        if (txCount >= 1000) return "Dire";
        if (txCount >= 250) return "Alpha";
        if (txCount >= 50) return "Hound";
        return "Pup";
    }

    function _accent(uint256 amount) private pure returns (string memory) {
        uint256 txCount = amount / BARK_PER_TX;
        if (txCount >= 1000) return "#ff5c7a";
        if (txCount >= 250) return "#f0a020";
        if (txCount >= 50) return "#5cffc4";
        return "#3ddcff";
    }

    /// Whole BARK with thousands separators: "2,940", not "2940.000000000000000000".
    function _grouped(uint256 value) private pure returns (string memory) {
        bytes memory digits = bytes(value.toString());
        uint256 len = digits.length;
        uint256 commas = (len - 1) / 3;
        if (commas == 0) return string(digits);

        bytes memory out = new bytes(len + commas);
        uint256 w = out.length;
        for (uint256 i = 0; i < len; ++i) {
            if (i > 0 && i % 3 == 0) out[--w] = ",";
            out[--w] = digits[len - 1 - i];
        }
        return string(out);
    }

    function _svg(uint256 tokenId, uint256 amount) private pure returns (string memory) {
        string memory accent = _accent(amount);
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">',
            '<rect width="400" height="400" fill="#05060a"/>',
            '<circle cx="200" cy="120" r="150" fill="', accent, '" opacity="0.10"/>',
            '<circle cx="200" cy="132" r="34" fill="', accent, '"/>',
            '<circle cx="162" cy="94" r="15" fill="', accent, '"/>',
            '<circle cx="238" cy="94" r="15" fill="', accent, '"/>',
            '<circle cx="176" cy="66" r="11" fill="', accent, '"/>',
            '<circle cx="224" cy="66" r="11" fill="', accent, '"/>',
            '<text x="200" y="228" text-anchor="middle" fill="#eef3f8" font-family="monospace" font-size="15" letter-spacing="5">BARK CLAIM PASS</text>',
            '<text x="200" y="286" text-anchor="middle" fill="', accent, '" font-family="monospace" font-size="42" font-weight="bold">', _grouped(amount / 1e18), '</text>',
            '<text x="200" y="310" text-anchor="middle" fill="#8b93a7" font-family="monospace" font-size="13" letter-spacing="3">BARK</text>',
            '<text x="28" y="360" fill="#8b93a7" font-family="monospace" font-size="13">', (amount / BARK_PER_TX).toString(), ' TX</text>',
            '<text x="200" y="360" text-anchor="middle" fill="#8b93a7" font-family="monospace" font-size="13">', tierOf(amount), '</text>',
            '<text x="372" y="360" text-anchor="end" fill="#8b93a7" font-family="monospace" font-size="13">#', tokenId.toString(), '</text>',
            '<rect x="0.5" y="0.5" width="399" height="399" fill="none" stroke="', accent, '" stroke-opacity="0.35"/>',
            "</svg>"
        );
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (_ownerOf(tokenId) == address(0)) revert NoSuchToken();
        uint256 amount = claimedBy(tokenId);
        string memory json = string.concat(
            '{"name":"BARK Claim Pass #', tokenId.toString(),
            '","description":"Minted by a wallet claiming its BARK airdrop on Base. The figures are read live from the airdrop contract.',
            '","image":"data:image/svg+xml;base64,', Base64.encode(bytes(_svg(tokenId, amount))),
            '","attributes":[',
            '{"trait_type":"Tier","value":"', tierOf(amount), '"},',
            '{"trait_type":"Base transactions","value":', (amount / BARK_PER_TX).toString(), '},',
            '{"trait_type":"BARK claimed","value":', (amount / 1e18).toString(), '},',
            '{"display_type":"date","trait_type":"Minted","value":', uint256(mintedAt[tokenId]).toString(), '}]}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }
}
