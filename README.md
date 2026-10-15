# Rally — all-or-nothing crowdfunding on BOT Chain

Creators set a goal in BOT and a deadline (1–90 days). Backers pledge BOT and can take
their pledge back any time before the deadline.

- **Goal reached by the deadline** → the creator collects the total minus a 1% platform fee.
- **Goal missed, or the creator cancels** → every backer refunds their full pledge.

The contract holds all funds until one of those outcomes. Payouts are pull-based
(credited, then withdrawn), so one bad recipient can't block anyone else.

## Security properties (covered by tests)
- Fee hard-capped at 3%; owner can't touch pledged funds
- Creator can't cancel after the deadline, so a funded campaign can't be pulled
- Backers can't refund a funded campaign; creators can't claim a failed one
- Pause only blocks new campaigns and pledges — unpledge, claim, refund and withdraw always work
- ReentrancyGuard on every function that moves BOT; two-step ownership transfer
- Solvency invariant: contract balance == running pledges + unrefunded failed pledges + credited balances

## Run
```bash
npm install
npx hardhat test               # if the solc CDN is blocked: USE_SOLCJS=1 npx hardhat test
cp .env.example .env           # PRIVATE_KEY, BOT_RPC_URL, OWNER_ADDRESS, TREASURY_ADDRESS
npx hardhat run scripts/deploy.js --network botMainnet
```
Then put the printed address in `docs/index.html` → `CONFIG.contract` and deploy `docs/` (Vercel, Netlify Drop or GitHub Pages).

BOT Chain mainnet: chain ID 677, gas token BOT, explorer https://scan.botchain.ai.
