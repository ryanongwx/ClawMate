// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ChessBetEscrow {
    address public owner;
    /// Resolver can call resolveGame; set by owner so backend can use a dedicated wallet (RESOLVER_PRIVATE_KEY).
    address public resolver;
    mapping(uint256 => Game) public games;
    uint256 public gameCounter;

    struct Game {
        address player1;
        address player2;
        uint256 betAmount;
        bool active;
        address winner; // address(0) for draw
    }

    event LobbyCreated(uint256 gameId, address player1, uint256 betAmount);
    event LobbyJoined(uint256 gameId, address player2);
    event LobbyCancelled(uint256 gameId, address player1);
    event GameResolved(uint256 gameId, address winner);
    event ResolverSet(address resolver);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    /// Owner or resolver can resolve games (resolver allows backend to use a dedicated key without being owner).
    modifier onlyOwnerOrResolver() {
        require(msg.sender == owner || msg.sender == resolver, "Not owner or resolver");
        _;
    }

    constructor() {
        owner = msg.sender;
        resolver = address(0);
    }

    /// Owner sets the resolver address (e.g. backend wallet). Only owner or resolver can call resolveGame.
    function setResolver(address _resolver) external onlyOwner {
        resolver = _resolver;
        emit ResolverSet(_resolver);
    }

    function createLobby() external payable {
        require(msg.value > 0, "Bet must be >0");
        gameCounter++;
        games[gameCounter] = Game({
            player1: msg.sender,
            player2: address(0),
            betAmount: msg.value,
            active: true,
            winner: address(0)
        });
        emit LobbyCreated(gameCounter, msg.sender, msg.value);
    }

    function joinLobby(uint256 gameId) external payable {
        Game storage game = games[gameId];
        require(game.active && game.player2 == address(0), "Invalid lobby");
        require(msg.value == game.betAmount, "Bet mismatch");
        game.player2 = msg.sender;
        emit LobbyJoined(gameId, msg.sender);
    }

    /// Creator can cancel before anyone joins; refunds their bet.
    function cancelLobby(uint256 gameId) external {
        Game storage game = games[gameId];
        require(game.active, "Game not active");
        require(game.player2 == address(0), "Lobby already has opponent");
        require(msg.sender == game.player1, "Only creator can cancel");
        game.active = false;
        (bool ok,) = payable(game.player1).call{value: game.betAmount}("");
        require(ok, "Transfer failed");
        emit LobbyCancelled(gameId, game.player1);
    }

    function resolveGame(uint256 gameId, address _winner) external onlyOwnerOrResolver {
        Game storage game = games[gameId];
        require(game.active && game.player2 != address(0), "Game not ready");
        game.winner = _winner;
        game.active = false;

        if (_winner == address(0)) {
            // Draw: refund both
            (bool s1,) = payable(game.player1).call{value: game.betAmount}("");
            (bool s2,) = payable(game.player2).call{value: game.betAmount}("");
            require(s1 && s2, "Transfer failed");
        } else if (_winner == game.player1 || _winner == game.player2) {
            (bool ok,) = payable(_winner).call{value: game.betAmount * 2}("");
            require(ok, "Transfer failed");
        } else {
            revert("Invalid winner");
        }
        emit GameResolved(gameId, _winner);
    }

    /// Accept direct MON/ETH so the contract can hold balance for refunds (e.g. after redeploy).
    receive() external payable {}
}
