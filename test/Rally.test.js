const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const DAY = 24 * 3600;

async function deploy() {
  const [owner, treasury, creator, alice, bob, carol] = await ethers.getSigners();
  const r = await (await ethers.getContractFactory("Rally")).deploy(owner.address, treasury.address);
  return { r, owner, treasury, creator, alice, bob, carol };
}

async function withCampaign() {
  const f = await deploy();
  await f.r.connect(f.creator).createCampaign(E(10), 7 * DAY, "ipfs://c");
  return { ...f, id: 1n };
}

describe("Rally", () => {
  describe("create", () => {
    it("stores campaign", async () => {
      const { r, creator, id } = await loadFixture(withCampaign);
      const c = await r.getCampaign(id);
      expect(c.creator).to.equal(creator.address);
      expect(c.goal).to.equal(E(10));
      expect(await r.campaignCount()).to.equal(1);
    });
    it("rejects bad params", async () => {
      const { r, creator } = await loadFixture(deploy);
      await expect(r.connect(creator).createCampaign(0, DAY, "x")).to.be.revertedWithCustomError(r, "InvalidParams");
      await expect(r.connect(creator).createCampaign(1, DAY - 1, "x")).to.be.revertedWithCustomError(r, "InvalidParams");
      await expect(r.connect(creator).createCampaign(1, 91 * DAY, "x")).to.be.revertedWithCustomError(r, "InvalidParams");
      await expect(r.connect(creator).createCampaign(1, DAY, "")).to.be.revertedWithCustomError(r, "InvalidParams");
    });
    it("unknown campaign reverts", async () => {
      const { r, alice } = await loadFixture(deploy);
      await expect(r.connect(alice).pledge(5, { value: 1 })).to.be.revertedWithCustomError(r, "InvalidParams");
    });
  });

  describe("pledge / unpledge", () => {
    it("tracks totals and backers", async () => {
      const { r, alice, bob, id } = await loadFixture(withCampaign);
      await r.connect(alice).pledge(id, { value: E(3) });
      await r.connect(alice).pledge(id, { value: E(1) });
      await r.connect(bob).pledge(id, { value: E(2) });
      const c = await r.getCampaign(id);
      expect(c.pledged).to.equal(E(6));
      expect(c.backers).to.equal(2);
      expect(await r.pledgeOf(id, alice.address)).to.equal(E(4));
    });
    it("unpledge partial and full", async () => {
      const { r, alice, id } = await loadFixture(withCampaign);
      await r.connect(alice).pledge(id, { value: E(4) });
      await r.connect(alice).unpledge(id, E(1));
      expect((await r.getCampaign(id)).backers).to.equal(1);
      await r.connect(alice).unpledge(id, E(3));
      const c = await r.getCampaign(id);
      expect(c.pledged).to.equal(0);
      expect(c.backers).to.equal(0);
      await expect(r.connect(alice).withdraw()).to.changeEtherBalance(alice, E(4));
    });
    it("cannot unpledge more than pledged or zero", async () => {
      const { r, alice, id } = await loadFixture(withCampaign);
      await r.connect(alice).pledge(id, { value: E(1) });
      await expect(r.connect(alice).unpledge(id, E(2))).to.be.revertedWithCustomError(r, "InvalidParams");
      await expect(r.connect(alice).unpledge(id, 0)).to.be.revertedWithCustomError(r, "InvalidParams");
    });
    it("zero pledge rejected", async () => {
      const { r, alice, id } = await loadFixture(withCampaign);
      await expect(r.connect(alice).pledge(id)).to.be.revertedWithCustomError(r, "InvalidParams");
    });
    it("no pledge or unpledge after deadline", async () => {
      const { r, alice, id } = await loadFixture(withCampaign);
      await r.connect(alice).pledge(id, { value: E(1) });
      await time.increase(7 * DAY);
      await expect(r.connect(alice).pledge(id, { value: 1 })).to.be.revertedWithCustomError(r, "CampaignEnded");
      await expect(r.connect(alice).unpledge(id, 1)).to.be.revertedWithCustomError(r, "CampaignEnded");
    });
  });

  describe("success", () => {
    it("creator claims after deadline, 1% fee to treasury", async () => {
      const { r, treasury, creator, alice, bob, id } = await loadFixture(withCampaign);
      await r.connect(alice).pledge(id, { value: E(6) });
      await r.connect(bob).pledge(id, { value: E(6) });
      await expect(r.connect(creator).claim(id)).to.be.revertedWithCustomError(r, "CampaignActive");
      await time.increase(7 * DAY);
      await expect(r.connect(creator).claim(id)).to.emit(r, "Claimed").withArgs(id, creator.address, E(11.88), E(0.12));
      await expect(r.connect(creator).withdraw()).to.changeEtherBalance(creator, E(11.88));
      await expect(r.connect(treasury).withdraw()).to.changeEtherBalance(treasury, E(0.12));
      expect(await ethers.provider.getBalance(r.target)).to.equal(0);
    });
    it("only creator, only once; backers can't refund a success", async () => {
      const { r, creator, alice, id } = await loadFixture(withCampaign);
      await r.connect(alice).pledge(id, { value: E(10) });
      await time.increase(7 * DAY);
      await expect(r.connect(alice).claim(id)).to.be.revertedWithCustomError(r, "NotAuthorized");
      await expect(r.connect(alice).refund(id)).to.be.revertedWithCustomError(r, "GoalMet");
      await r.connect(creator).claim(id);
      await expect(r.connect(creator).claim(id)).to.be.revertedWithCustomError(r, "AlreadyDone");
    });
  });

  describe("failure & cancel", () => {
    it("goal missed: backers refund, creator can't claim", async () => {
      const { r, creator, alice, bob, id } = await loadFixture(withCampaign);
      await r.connect(alice).pledge(id, { value: E(3) });
      await r.connect(bob).pledge(id, { value: E(2) });
      await expect(r.connect(alice).refund(id)).to.be.revertedWithCustomError(r, "CampaignActive");
      await time.increase(7 * DAY);
      await expect(r.connect(creator).claim(id)).to.be.revertedWithCustomError(r, "GoalNotMet");
      await r.connect(alice).refund(id);
      await expect(r.connect(alice).refund(id)).to.be.revertedWithCustomError(r, "NothingToWithdraw");
      await r.connect(bob).refund(id);
      await expect(r.connect(alice).withdraw()).to.changeEtherBalance(alice, E(3));
      await expect(r.connect(bob).withdraw()).to.changeEtherBalance(bob, E(2));
    });
    it("cancel lets backers refund immediately; blocks pledges and claim", async () => {
      const { r, creator, alice, id } = await loadFixture(withCampaign);
      await r.connect(alice).pledge(id, { value: E(20) });
      await expect(r.connect(alice).cancel(id)).to.be.revertedWithCustomError(r, "NotAuthorized");
      await r.connect(creator).cancel(id);
      await expect(r.connect(alice).pledge(id, { value: 1 })).to.be.revertedWithCustomError(r, "AlreadyDone");
      await r.connect(alice).refund(id);
      await time.increase(7 * DAY);
      await expect(r.connect(creator).claim(id)).to.be.revertedWithCustomError(r, "AlreadyDone");
      await expect(r.connect(alice).withdraw()).to.changeEtherBalance(alice, E(20));
    });
    it("cannot cancel after deadline (so a met goal can't be yanked)", async () => {
      const { r, creator, alice, id } = await loadFixture(withCampaign);
      await r.connect(alice).pledge(id, { value: E(10) });
      await time.increase(7 * DAY);
      await expect(r.connect(creator).cancel(id)).to.be.revertedWithCustomError(r, "CampaignEnded");
    });
  });

  describe("admin", () => {
    it("fee capped at 3%, owner only", async () => {
      const { r, owner, alice, treasury } = await loadFixture(deploy);
      await expect(r.connect(alice).setConfig(50, treasury.address)).to.be.revertedWithCustomError(r, "OwnableUnauthorizedAccount");
      await expect(r.connect(owner).setConfig(301, treasury.address)).to.be.revertedWithCustomError(r, "InvalidParams");
      await expect(r.connect(owner).setConfig(100, ethers.ZeroAddress)).to.be.revertedWithCustomError(r, "InvalidParams");
      await r.connect(owner).setConfig(300, alice.address);
      expect(await r.feeBps()).to.equal(300);
    });
    it("pause blocks create/pledge but never exits", async () => {
      const { r, owner, creator, alice, id } = await loadFixture(withCampaign);
      await r.connect(alice).pledge(id, { value: E(2) });
      await r.connect(owner).pause();
      await expect(r.connect(creator).createCampaign(1, DAY, "x")).to.be.revertedWithCustomError(r, "EnforcedPause");
      await expect(r.connect(alice).pledge(id, { value: 1 })).to.be.revertedWithCustomError(r, "EnforcedPause");
      await r.connect(alice).unpledge(id, E(2));
      await expect(r.connect(alice).withdraw()).to.changeEtherBalance(alice, E(2));
    });
    it("two-step ownership", async () => {
      const { r, owner, alice } = await loadFixture(deploy);
      await r.connect(owner).transferOwnership(alice.address);
      expect(await r.owner()).to.equal(owner.address);
      await r.connect(alice).acceptOwnership();
      expect(await r.owner()).to.equal(alice.address);
    });
  });

  describe("safety", () => {
    it("a backer that rejects BOT can't block others", async () => {
      const { r, creator, alice, id } = await loadFixture(withCampaign);
      const rej = await (await ethers.getContractFactory("Rejecter")).deploy();
      await rej.call(r.target, r.interface.encodeFunctionData("pledge", [id]), { value: E(1) });
      await r.connect(alice).pledge(id, { value: E(1) });
      await r.connect(creator).cancel(id);
      await rej.call(r.target, r.interface.encodeFunctionData("refund", [id]));
      await expect(rej.call(r.target, r.interface.encodeFunctionData("withdraw", []))).to.be.reverted;
      await r.connect(alice).refund(id);
      await expect(r.connect(alice).withdraw()).to.changeEtherBalance(alice, E(1));
    });

    it("solvency: contract balance == live pledges + credited balances", async () => {
      const { r, treasury, creator, alice, bob, carol } = await loadFixture(deploy);
      await r.connect(creator).createCampaign(E(5), 3 * DAY, "a");  // will succeed
      await r.connect(creator).createCampaign(E(50), 3 * DAY, "b"); // will fail
      await r.connect(creator).createCampaign(E(5), 30 * DAY, "c"); // cancelled
      await r.connect(creator).createCampaign(E(5), 30 * DAY, "d"); // still running
      await r.connect(alice).pledge(1, { value: E(3) }); await r.connect(bob).pledge(1, { value: E(4) });
      await r.connect(alice).pledge(2, { value: E(7) }); await r.connect(carol).pledge(2, { value: E(1) });
      await r.connect(bob).pledge(3, { value: E(2) });
      await r.connect(carol).pledge(4, { value: E(9) }); await r.connect(carol).unpledge(4, E(4));
      await r.connect(creator).cancel(3);
      await time.increase(3 * DAY);
      await r.connect(creator).claim(1);
      await r.connect(alice).refund(2);
      await r.connect(bob).refund(3);
      await r.connect(creator).withdraw();

      const unrefunded = await r.pledgeOf(2, carol.address); // failed but not yet refunded
      const running = (await r.getCampaign(4)).pledged;
      let credited = 0n;
      for (const a of [treasury, creator, alice, bob, carol]) credited += await r.balanceOf(a.address);
      expect(await ethers.provider.getBalance(r.target)).to.equal(unrefunded + running + credited);
    });
  });
});
