// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/**
 * A receipt for claiming BARK: one pass per claim, recording the wallet's Base
 * transaction count and the allocation that count earned.
 *
 * Art and metadata are generated in the contract. The project's pitch is that the
 * liquidity is locked forever, and an NFT whose image dies with an IPFS pin makes a
 * liar of that — so there is no off-chain dependency here at all.
 */
contract BarkClaimPass is ERC721, Ownable {
    using Strings for uint256;

    struct Pass {
        uint64 txCount;   // Base transactions the wallet had when it claimed
        uint64 mintedAt;  // block timestamp
        uint128 amount;   // BARK claimed, in wei
    }

    mapping(uint256 => Pass) public passes;

    uint256 public totalMinted;
    address public minter;

    event MinterSet(address indexed minter);
    event PassMinted(uint256 indexed tokenId, address indexed to, uint64 txCount, uint128 amount);

    error NotMinter();
    error NoSuchToken();

    constructor(address owner_) ERC721("BARK Claim Pass", "BARKPASS") Ownable(owner_) {}

    modifier onlyMinter() {
        if (msg.sender != minter) revert NotMinter();
        _;
    }

    /// The claim contract is the only thing allowed to mint. Settable so the claim
    /// front end can be replaced without redeploying the collection.
    function setMinter(address minter_) external onlyOwner {
        minter = minter_;
        emit MinterSet(minter_);
    }

    function mint(address to, uint64 txCount, uint128 amount) external onlyMinter returns (uint256 tokenId) {
        tokenId = ++totalMinted;
        passes[tokenId] = Pass({txCount: txCount, mintedAt: uint64(block.timestamp), amount: amount});
        _safeMint(to, tokenId);
        emit PassMinted(tokenId, to, txCount, amount);
    }

    /* ------------------------------------------------------------- metadata */

    /// Rarity falls out of the airdrop's own rule: more Base history, higher tier.
    function tierOf(uint64 txCount) public pure returns (string memory) {
        if (txCount >= 1000) return "Dire";
        if (txCount >= 250) return "Alpha";
        if (txCount >= 50) return "Hound";
        return "Pup";
    }

    function _accent(uint64 txCount) private pure returns (string memory) {
        if (txCount >= 1000) return "#ff5c7a";
        if (txCount >= 250) return "#f0a020";
        if (txCount >= 50) return "#5cffc4";
        return "#3ddcff";
    }

    /// Whole BARK with thousands separators: "2,940", not "2940.000000000000000000".
    /// The amount is the hero of the card, so it is worth the few hundred gas to group it.
    function _whole(uint128 amount) private pure returns (string memory) {
        bytes memory digits = bytes((uint256(amount) / 1e18).toString());
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

    function _svg(uint256 tokenId, Pass memory p) private pure returns (string memory) {
        string memory accent = _accent(p.txCount);
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
            '<text x="200" y="286" text-anchor="middle" fill="', accent, '" font-family="monospace" font-size="42" font-weight="bold">', _whole(p.amount), '</text>',
            '<text x="200" y="310" text-anchor="middle" fill="#8b93a7" font-family="monospace" font-size="13" letter-spacing="3">BARK</text>',
            '<text x="28" y="360" fill="#8b93a7" font-family="monospace" font-size="13">', uint256(p.txCount).toString(), ' TX</text>',
            '<text x="200" y="360" text-anchor="middle" fill="#8b93a7" font-family="monospace" font-size="13">', tierOf(p.txCount), '</text>',
            '<text x="372" y="360" text-anchor="end" fill="#8b93a7" font-family="monospace" font-size="13">#', tokenId.toString(), '</text>',
            '<rect x="0.5" y="0.5" width="399" height="399" fill="none" stroke="', accent, '" stroke-opacity="0.35"/>',
            "</svg>"
        );
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (_ownerOf(tokenId) == address(0)) revert NoSuchToken();
        Pass memory p = passes[tokenId];
        string memory json = string.concat(
            '{"name":"BARK Claim Pass #', tokenId.toString(),
            '","description":"Minted when this wallet claimed its BARK airdrop on Base. Mint proceeds seeded the BARK liquidity pool.',
            '","image":"data:image/svg+xml;base64,', Base64.encode(bytes(_svg(tokenId, p))),
            '","attributes":[',
            '{"trait_type":"Tier","value":"', tierOf(p.txCount), '"},',
            '{"trait_type":"Base transactions","value":', uint256(p.txCount).toString(), '},',
            '{"trait_type":"BARK claimed","value":', _whole(p.amount), '},',
            '{"display_type":"date","trait_type":"Claimed","value":', uint256(p.mintedAt).toString(), '}]}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }
}
