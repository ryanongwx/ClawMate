const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ChessBetEscrow", function () {
  let escrow;
  let owner;
  let player1;
  let player2;
  const betAmount = ethers.parseEther("0.1");

  beforeEach(async function () {
    [owner, player1, player2] = await ethers.getSigners();
    const ChessBetEscrow = await ethers.getContractFactory("ChessBetEscrow");
    escrow = await ChessBetEscrow.deploy();
    await escrow.waitForDeployment();
  });

  describe("deployment", function () {
    it("should set the owner", async function () {
      expect(await escrow.owner()).to.equal(owner.address);
    });
    it("should start with gameCounter 0", async function () {
      expect(await escrow.gameCounter()).to.equal(0);
    });
  });

  describe("createLobby", function () {
    it("should create a lobby when value > 0", async function () {
      await expect(escrow.connect(player1).createLobby({ value: betAmount }))
        .to.emit(escrow, "LobbyCreated")
        .withArgs(1, player1.address, betAmount);
      expect(await escrow.gameCounter()).to.equal(1);
      const game = await escrow.games(1);
      expect(game.player1).to.equal(player1.address);
      expect(game.player2).to.equal(ethers.ZeroAddress);
      expect(game.betAmount).to.equal(betAmount);
      expect(game.active).to.be.true;
      expect(game.winner).to.equal(ethers.ZeroAddress);
    });
    it("should revert when value is 0", async function () {
      await expect(escrow.connect(player1).createLobby({ value: 0 }))
        .to.be.revertedWith("Bet must be >0");
    });
  });

  describe("joinLobby", function () {
    beforeEach(async function () {
      await escrow.connect(player1).createLobby({ value: betAmount });
    });

    it("should let player2 join with same bet", async function () {
      await expect(escrow.connect(player2).joinLobby(1, { value: betAmount }))
        .to.emit(escrow, "LobbyJoined")
        .withArgs(1, player2.address);
      const game = await escrow.games(1);
      expect(game.player2).to.equal(player2.address);
    });
    it("should revert when bet amount mismatch", async function () {
      await expect(
        escrow.connect(player2).joinLobby(1, { value: ethers.parseEther("0.2") })
      ).to.be.revertedWith("Bet mismatch");
    });
    it("should revert when joining same lobby twice", async function () {
      await escrow.connect(player2).joinLobby(1, { value: betAmount });
      await expect(
        escrow.connect(owner).joinLobby(1, { value: betAmount })
      ).to.be.revertedWith("Invalid lobby");
    });
  });

  describe("cancelLobby", function () {
    beforeEach(async function () {
      await escrow.connect(player1).createLobby({ value: betAmount });
    });

    it("should refund creator when they cancel before anyone joins", async function () {
      const before = await ethers.provider.getBalance(player1.address);
      const tx = await escrow.connect(player1).cancelLobby(1);
      await expect(tx).to.emit(escrow, "LobbyCancelled").withArgs(1, player1.address);
      const receipt = await tx.wait();
      const after = await ethers.provider.getBalance(player1.address);
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      expect(after - before).to.equal(betAmount - gasCost);
      const game = await escrow.games(1);
      expect(game.active).to.be.false;
    });
    it("should revert when non-creator cancels", async function () {
      await expect(escrow.connect(player2).cancelLobby(1))
        .to.be.revertedWith("Only creator can cancel");
    });
    it("should revert when cancelling after opponent joined", async function () {
      await escrow.connect(player2).joinLobby(1, { value: betAmount });
      await expect(escrow.connect(player1).cancelLobby(1))
        .to.be.revertedWith("Lobby already has opponent");
    });
  });

  describe("resolveGame", function () {
    beforeEach(async function () {
      await escrow.connect(player1).createLobby({ value: betAmount });
      await escrow.connect(player2).joinLobby(1, { value: betAmount });
    });

    it("should pay winner when owner resolves", async function () {
      const before = await ethers.provider.getBalance(player1.address);
      await escrow.resolveGame(1, player1.address);
      const after = await ethers.provider.getBalance(player1.address);
      expect(after - before).to.equal(betAmount * 2n);
    });
    it("should refund both on draw (winner = address(0))", async function () {
      const p1Before = await ethers.provider.getBalance(player1.address);
      const p2Before = await ethers.provider.getBalance(player2.address);
      await escrow.resolveGame(1, ethers.ZeroAddress);
      const p1After = await ethers.provider.getBalance(player1.address);
      const p2After = await ethers.provider.getBalance(player2.address);
      expect(p1After - p1Before).to.equal(betAmount);
      expect(p2After - p2Before).to.equal(betAmount);
    });
    it("should revert when non-owner and non-resolver resolves", async function () {
      await expect(
        escrow.connect(player1).resolveGame(1, player1.address)
      ).to.be.revertedWith("Not owner or resolver");
    });
    it("should pay winner when resolver resolves after setResolver", async function () {
      const [,,, resolver] = await ethers.getSigners();
      await escrow.setResolver(resolver.address);
      const before = await ethers.provider.getBalance(player2.address);
      const tx = await escrow.connect(resolver).resolveGame(1, player2.address);
      await tx.wait();
      const after = await ethers.provider.getBalance(player2.address);
      expect(after - before).to.equal(betAmount * 2n);
    });
    it("should revert when invalid winner", async function () {
      const invalidWinner = "0x0000000000000000000000000000000000000123";
      await expect(
        escrow.resolveGame(1, invalidWinner)
      ).to.be.revertedWith("Invalid winner");
    });
  });
});
